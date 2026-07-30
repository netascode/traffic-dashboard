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

if (!fs.existsSync(configPath)) {
  console.error(`Missing config file: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const fetchJson = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    headers: {
      'User-Agent': 'traffic-dashboard-sync',
      'Accept': 'application/json',
    },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`${res.statusCode} ${url} ${body.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
  req.on('error', reject);
});

const repoToFileSlug = (repo) => repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultHistoryPath = (repo) => `${historyDir}/${repoToFileSlug(repo)}.registry.json`;

const ensureDir = (filePath) => {
  const dir = filePath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const daysBetween = (isoA, isoB) => {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(b - a) / (24 * 60 * 60 * 1000);
};

const computeTotals = (snapshots) => {
  if (!snapshots.length) return { current_total: 0, week_delta_avg: 0, month_delta_avg: 0 };
  const last = snapshots[snapshots.length - 1];
  const currentTotal = last.total || 0;

  const weekDeltas = [];
  const monthDeltas = [];
  const now = last.polled_at;
  for (const s of snapshots) {
    const daysAgo = daysBetween(s.polled_at, now);
    if (daysAgo !== null && daysAgo <= 90 && typeof s.week === 'number') weekDeltas.push(s.week);
    if (daysAgo !== null && daysAgo <= 90 && typeof s.month === 'number') monthDeltas.push(s.month);
  }
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  return {
    current_total: currentTotal,
    week_delta_avg: avg(weekDeltas),
    month_delta_avg: avg(monthDeltas),
  };
};

async function fetchTerraform(reg) {
  const url = `https://registry.terraform.io/v2/modules/${reg.namespace}/${reg.name}/${reg.provider}/downloads/summary`;
  const data = await fetchJson(url);
  const attrs = data && data.data && data.data.attributes ? data.data.attributes : {};
  return {
    week: attrs.week ?? null,
    month: attrs.month ?? null,
    year: attrs.year ?? null,
    total: attrs.total ?? null,
  };
}

async function fetchTerraformProvider(reg) {
  // Providers only expose a total download count via the v1 provider details endpoint.
  const url = `https://registry.terraform.io/v1/providers/${reg.namespace}/${reg.name}`;
  const data = await fetchJson(url);
  return {
    week: null,
    month: null,
    year: null,
    total: typeof data.downloads === 'number' ? data.downloads : null,
  };
}

async function fetchGalaxy(reg) {
  const url = `https://galaxy.ansible.com/api/v3/collections/${reg.namespace}/${reg.name}/`;
  const data = await fetchJson(url);
  return {
    total: data && typeof data.download_count === 'number' ? data.download_count : null,
    week: null,
    month: null,
    year: null,
  };
}

async function syncRepoRegistry(item) {
  const repo = item.repo;
  if (!repo || !repo.includes('/')) {
    return { repo: item.repo || 'unknown', changed: false, reason: 'invalid repo' };
  }
  const reg = item.registry;
  if (!reg || !reg.type) {
    return { repo, changed: false, reason: 'no registry config' };
  }

  let snapshot;
  if (reg.type === 'terraform') {
    snapshot = await fetchTerraform(reg);
  } else if (reg.type === 'terraform-provider') {
    snapshot = await fetchTerraformProvider(reg);
  } else if (reg.type === 'galaxy') {
    snapshot = await fetchGalaxy(reg);
  } else {
    return { repo, changed: false, reason: `unknown registry type: ${reg.type}` };
  }
  snapshot.polled_at = new Date().toISOString();

  const historyPath = item.registryPath || defaultHistoryPath(repo);
  let existing = { type: reg.type, snapshots: [], totals: {}, lastUpdated: null };
  if (fs.existsSync(historyPath)) {
    existing = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!Array.isArray(existing.snapshots)) existing.snapshots = [];
    existing.type = reg.type;
  }

  // Deduplicate: if the last snapshot has identical numbers, skip appending (keeps the file lean).
  const last = existing.snapshots[existing.snapshots.length - 1];
  const numbersEqual = last
    && last.total === snapshot.total
    && last.week === snapshot.week
    && last.month === snapshot.month
    && last.year === snapshot.year;

  if (numbersEqual) {
    // Refresh totals in case rolling window advanced; only write if something changed.
    const refreshedTotals = computeTotals(existing.snapshots);
    if (JSON.stringify(refreshedTotals) === JSON.stringify(existing.totals)) {
      return { repo, changed: false, historyPath };
    }
    existing.totals = refreshedTotals;
    existing.lastUpdated = new Date().toISOString();
    ensureDir(historyPath);
    fs.writeFileSync(historyPath, JSON.stringify(existing, null, 2) + '\n');
    return { repo, changed: true, historyPath, reason: 'totals-only' };
  }

  existing.snapshots.push(snapshot);
  existing.totals = computeTotals(existing.snapshots);
  existing.lastUpdated = new Date().toISOString();

  ensureDir(historyPath);
  fs.writeFileSync(historyPath, JSON.stringify(existing, null, 2) + '\n');
  return { repo, changed: true, historyPath };
}

async function main() {
  const repos = config.repos || [];
  if (!repos.length) {
    console.error('No repos in config.');
    process.exit(1);
  }

  let changed = 0;
  let skipped = 0;
  for (const item of repos) {
    try {
      const result = await syncRepoRegistry(item);
      if (result.changed) {
        changed += 1;
        console.log(`Updated ${result.repo} -> ${result.historyPath}${result.reason ? ` (${result.reason})` : ''}`);
      } else if (result.reason === 'no registry config') {
        skipped += 1;
      } else {
        console.log(`No change ${result.repo}`);
      }
    } catch (err) {
      console.error(`Failed ${item.repo}: ${err.message}`);
    }
  }

  console.log(`Registry sync completed. Changed: ${changed}/${repos.length}, skipped (no config): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
