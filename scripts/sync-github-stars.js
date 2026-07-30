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
// Only the scalar /repos/{owner}/{repo} endpoint is used, so any token (including
// TRAFFIC_PAT scoped to netascode) works for both netascode and CiscoDevNet public data.
const token = process.env.PUBLIC_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.error('Missing token. Set PUBLIC_TOKEN, GITHUB_TOKEN, or GH_TOKEN.');
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Missing config file: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const apiGet = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    headers: {
      'User-Agent': 'traffic-dashboard-sync',
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`${res.statusCode} ${url} ${body.slice(0, 200)}`));
        return;
      }
      try { resolve({ body: JSON.parse(body), headers: res.headers }); }
      catch (err) { reject(err); }
    });
  });
  req.on('error', reject);
});

const repoToFileSlug = (repo) => repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultHistoryPath = (repo) => `${historyDir}/${repoToFileSlug(repo)}.stars.json`;

const ensureDir = (filePath) => {
  const dir = filePath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Convert a preserved per-star history (each entry has starred_at) into daily snapshots.
// Useful for netascode files created when we had per-star pagination access. Produces one
// snapshot per unique date on which a star occurred; the total is cumulative up to that date.
function backfillSnapshotsFromStars(stars) {
  const sorted = [...stars].sort((a, b) => (a.starred_at || '').localeCompare(b.starred_at || ''));
  const dateToCount = new Map();
  let count = 0;
  for (const s of sorted) {
    if (!s.starred_at) continue;
    count += 1;
    dateToCount.set(s.starred_at.slice(0, 10), count);
  }
  return [...dateToCount.entries()].map(([date, total]) => ({
    polled_at: `${date}T00:00:00Z`,
    total,
    backfilled: true,
  }));
}

function computeTotals(snapshots) {
  if (!snapshots.length) return { total: 0, last30d: null, last90d: null, velocity30d: null };
  const currentTotal = snapshots[snapshots.length - 1].total || 0;
  const now = Date.now();
  const findAtOrBefore = (targetMs) => {
    let best = null;
    for (const s of snapshots) {
      const t = Date.parse(s.polled_at);
      if (Number.isFinite(t) && t <= targetMs) best = s;
    }
    return best;
  };
  const at30 = findAtOrBefore(now - 30 * 24 * 60 * 60 * 1000);
  const at90 = findAtOrBefore(now - 90 * 24 * 60 * 60 * 1000);
  return {
    total: currentTotal,
    last30d: at30 ? currentTotal - (at30.total || 0) : null,
    last90d: at90 ? currentTotal - (at90.total || 0) : null,
    velocity30d: at30 ? Number(((currentTotal - (at30.total || 0)) / 30).toFixed(3)) : null,
  };
}

async function syncRepoStars(item) {
  const repo = item.repo;
  if (!repo || !repo.includes('/')) {
    return { repo: item.repo || 'unknown', changed: false, reason: 'invalid repo' };
  }
  if (Array.isArray(item.signals) && !item.signals.includes('stars')) {
    return { repo, changed: false, reason: 'stars disabled by config' };
  }

  const [owner, name] = repo.split('/');
  const historyPath = item.starsPath || defaultHistoryPath(repo);

  const repoMeta = await apiGet(`https://api.github.com/repos/${owner}/${name}`);
  const currentTotal = repoMeta.body.stargazers_count || 0;

  let existing = { stars: [], snapshots: [], totals: {}, lastUpdated: null };
  if (fs.existsSync(historyPath)) {
    existing = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!Array.isArray(existing.stars)) existing.stars = [];
    if (!Array.isArray(existing.snapshots)) existing.snapshots = [];
  }

  let mutated = false;

  // Backfill from preserved per-star history the first time we run under the scalar scheme.
  if (existing.stars.length > 0 && existing.snapshots.length === 0) {
    existing.snapshots = backfillSnapshotsFromStars(existing.stars);
    mutated = true;
  }

  // Append (or replace) today's snapshot. Idempotent within the same UTC day.
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const lastIdx = existing.snapshots.length - 1;
  const last = existing.snapshots[lastIdx];
  if (last && (last.polled_at || '').slice(0, 10) === todayDate) {
    if ((last.total || 0) !== currentTotal) {
      existing.snapshots[lastIdx] = { polled_at: nowIso, total: currentTotal };
      mutated = true;
    }
  } else {
    existing.snapshots.push({ polled_at: nowIso, total: currentTotal });
    mutated = true;
  }

  const totals = computeTotals(existing.snapshots);
  if (JSON.stringify(existing.totals) !== JSON.stringify(totals)) mutated = true;

  const output = {
    stars: existing.stars,
    snapshots: existing.snapshots,
    totals,
    lastUpdated: nowIso,
  };

  if (!mutated) {
    return { repo, changed: false, historyPath };
  }

  ensureDir(historyPath);
  fs.writeFileSync(historyPath, JSON.stringify(output, null, 2) + '\n');
  return { repo, changed: true, historyPath };
}

async function main() {
  const repos = config.repos || [];
  if (!repos.length) { console.error('No repos in config.'); process.exit(1); }

  let changed = 0;
  for (const item of repos) {
    try {
      const result = await syncRepoStars(item);
      if (result.changed) {
        changed += 1;
        console.log(`Updated ${result.repo} -> ${result.historyPath}`);
      } else {
        console.log(`No change ${result.repo}${result.reason ? ` (${result.reason})` : ''}`);
      }
    } catch (err) {
      console.error(`Failed ${item.repo}: ${err.message}`);
    }
  }
  console.log(`Stars sync completed. Changed repos: ${changed}/${repos.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
