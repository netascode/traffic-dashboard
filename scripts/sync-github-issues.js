#!/usr/bin/env node
const fs = require('fs');
const https = require('https');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const configPath = getArg('--config', 'repos.json');
const historyDir = getArg('--historyDir', 'data/raw');
const memberCacheDays = Number(getArg('--memberCacheDays', '7'));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OWNER_TOKENS = { ciscodevnet: process.env.DEVNET_TOKEN };

if (!token) {
  console.error('Missing token. Set GITHUB_TOKEN or GH_TOKEN.');
  process.exit(1);
}

const tokenForUrl = (url) => {
  const match = url.match(/api\.github\.com\/(?:repos|orgs)\/([^/]+)/);
  const owner = match ? match[1].toLowerCase() : null;
  return (owner && OWNER_TOKENS[owner]) || token;
};

if (!fs.existsSync(configPath)) {
  console.error(`Missing config file: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const apiRaw = (url, method = 'GET') => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method,
    headers: {
      'User-Agent': 'traffic-dashboard-sync',
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${tokenForUrl(url)}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      resolve({ status: res.statusCode, body, headers: res.headers });
    });
  });
  req.on('error', reject);
  req.end();
});

const apiGet = async (url) => {
  const res = await apiRaw(url, 'GET');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${res.status} ${url} ${res.body.slice(0, 200)}`);
  }
  return { body: JSON.parse(res.body), headers: res.headers };
};

const parseNextLink = (linkHeader) => {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
};

const repoToFileSlug = (repo) => repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultHistoryPath = (repo) => `${historyDir}/${repoToFileSlug(repo)}.issues.json`;
const memberCachePath = `${historyDir}/_org-members.json`;

const ensureDir = (filePath) => {
  const dir = filePath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Org membership cache: { checked_at, members: { login: bool } }.
// Refreshed weekly (memberCacheDays); between refreshes only new authors get looked up.
const loadMemberCache = () => {
  if (fs.existsSync(memberCachePath)) {
    const data = JSON.parse(fs.readFileSync(memberCachePath, 'utf8'));
    const staleMs = memberCacheDays * 24 * 60 * 60 * 1000;
    if (data.checked_at && (Date.now() - Date.parse(data.checked_at)) < staleMs) {
      return { checked_at: data.checked_at, members: data.members || {}, stale: false };
    }
    return { checked_at: data.checked_at, members: data.members || {}, stale: true };
  }
  return { checked_at: null, members: {}, stale: true };
};

const saveMemberCache = (cache) => {
  ensureDir(memberCachePath);
  fs.writeFileSync(memberCachePath, JSON.stringify({
    checked_at: cache.checked_at,
    members: cache.members,
  }, null, 2) + '\n');
};

const cache = loadMemberCache();
const orgChecked = new Set(); // orgs whose cache we've already refreshed this run

const checkMembership = async (org, login) => {
  const key = `${org}/${login}`;
  if (Object.prototype.hasOwnProperty.call(cache.members, key) && !cache.stale) {
    return cache.members[key];
  }
  if (cache.stale && !orgChecked.has(org)) {
    // Purge stale entries for this org so they'll be re-verified this run.
    for (const k of Object.keys(cache.members)) {
      if (k.startsWith(`${org}/`)) delete cache.members[k];
    }
    orgChecked.add(org);
  }
  if (Object.prototype.hasOwnProperty.call(cache.members, key)) {
    return cache.members[key];
  }
  // Try authenticated members endpoint first, fall back to public_members if forbidden.
  const url = `https://api.github.com/orgs/${org}/members/${login}`;
  const res = await apiRaw(url, 'GET');
  let isMember;
  if (res.status === 204) isMember = true;
  else if (res.status === 404) isMember = false;
  else if (res.status === 403 || res.status === 302) {
    const pubUrl = `https://api.github.com/orgs/${org}/public_members/${login}`;
    const pub = await apiRaw(pubUrl, 'GET');
    isMember = pub.status === 204;
  } else {
    throw new Error(`Membership check failed ${res.status} ${url}`);
  }
  cache.members[key] = isMember;
  return isMember;
};

const computeTotals = (items) => {
  const now = Date.now();
  const day30 = now - 30 * 24 * 60 * 60 * 1000;
  let external_open = 0;
  let external_new_30d = 0;
  let external_closed_30d = 0;
  const authors = new Set();
  for (const it of items) {
    if (it.is_org_member) continue;
    if (it.type === 'pr') continue; // PRs excluded from external-community signal
    if (it.author_login) authors.add(it.author_login);
    if (it.state === 'open') external_open += 1;
    const created = Date.parse(it.created_at);
    const closed = Date.parse(it.closed_at || '');
    if (Number.isFinite(created) && created >= day30) external_new_30d += 1;
    if (Number.isFinite(closed) && closed >= day30) external_closed_30d += 1;
  }
  return {
    external_open,
    external_new_30d,
    external_closed_30d,
    external_authors_all_time: authors.size,
  };
};

async function syncRepoIssues(item) {
  const repo = item.repo;
  if (!repo || !repo.includes('/')) {
    return { repo: item.repo || 'unknown', changed: false, reason: 'invalid repo' };
  }
  if (Array.isArray(item.signals) && !item.signals.includes('issues')) {
    return { repo, changed: false, reason: 'issues disabled by config' };
  }

  const [owner, name] = repo.split('/');
  const historyPath = item.issuesPath || defaultHistoryPath(repo);

  let existing = { items: [], totals: {}, lastPolledAt: null };
  if (fs.existsSync(historyPath)) {
    existing = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!Array.isArray(existing.items)) existing.items = [];
  }

  // Incremental fetch: since last poll (with 1-hour overlap to catch race conditions).
  // If we've never polled, fetch everything (limit page count to avoid extreme cases).
  const since = existing.lastPolledAt
    ? new Date(Date.parse(existing.lastPolledAt) - 60 * 60 * 1000).toISOString()
    : null;

  const fetched = [];
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  let url = `https://api.github.com/repos/${owner}/${name}/issues?state=all&per_page=100&direction=asc${sinceParam}`;
  let pageCount = 0;
  const maxPages = since ? 50 : 100;
  while (url && pageCount < maxPages) {
    const res = await apiGet(url);
    for (const it of res.body || []) {
      const isPr = Boolean(it.pull_request);
      fetched.push({
        number: it.number,
        type: isPr ? 'pr' : 'issue',
        state: it.state,
        author_login: it.user ? it.user.login : null,
        is_org_member: null, // resolved below
        created_at: it.created_at,
        closed_at: it.closed_at || null,
        merged_at: isPr && it.pull_request ? (it.pull_request.merged_at || null) : null,
      });
    }
    url = parseNextLink(res.headers.link);
    pageCount += 1;
  }

  // Resolve membership for authors in the fetched batch (dedup by login).
  const uniqueLogins = [...new Set(fetched.map((it) => it.author_login).filter(Boolean))];
  const membershipByLogin = {};
  for (const login of uniqueLogins) {
    try {
      membershipByLogin[login] = await checkMembership(owner, login);
    } catch (err) {
      console.error(`  membership check failed for ${login}: ${err.message}`);
      membershipByLogin[login] = null;
    }
  }
  for (const it of fetched) {
    it.is_org_member = it.author_login ? membershipByLogin[it.author_login] : null;
  }

  // Merge on `number`: fetched entries replace existing entries with same number.
  const byNumber = new Map((existing.items || []).map((it) => [it.number, it]));
  for (const it of fetched) byNumber.set(it.number, it);
  const merged = [...byNumber.values()].sort((a, b) => (a.number || 0) - (b.number || 0));

  const totals = computeTotals(merged);
  const output = {
    items: merged,
    totals,
    lastPolledAt: new Date().toISOString(),
  };

  const before = JSON.stringify({ items: existing.items, totals: existing.totals });
  const after = JSON.stringify({ items: merged, totals });
  const nothingNew = before === after;

  if (nothingNew && existing.lastPolledAt) {
    // Update lastPolledAt so subsequent runs' `since` window stays tight, but skip file write if no data changed.
    // Actually rewrite with new timestamp so the next incremental fetch works.
    ensureDir(historyPath);
    fs.writeFileSync(historyPath, JSON.stringify(output, null, 2) + '\n');
    return { repo, changed: false, historyPath };
  }

  ensureDir(historyPath);
  fs.writeFileSync(historyPath, JSON.stringify(output, null, 2) + '\n');
  return { repo, changed: true, historyPath };
}

async function main() {
  const repos = config.repos || [];
  if (!repos.length) {
    console.error('No repos in config.');
    process.exit(1);
  }

  let changed = 0;
  for (const item of repos) {
    try {
      const result = await syncRepoIssues(item);
      if (result.changed) {
        changed += 1;
        console.log(`Updated ${result.repo} -> ${result.historyPath}`);
      } else {
        console.log(`No change ${result.repo}`);
      }
    } catch (err) {
      console.error(`Failed ${item.repo}: ${err.message}`);
    }
  }

  // Persist member cache. Only bump checked_at if we did a full refresh cycle.
  if (cache.stale && orgChecked.size > 0) {
    cache.checked_at = new Date().toISOString();
  } else if (!cache.checked_at) {
    cache.checked_at = new Date().toISOString();
  }
  saveMemberCache(cache);

  console.log(`Issues sync completed. Changed repos: ${changed}/${repos.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
