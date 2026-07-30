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
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.error('Missing token. Set GITHUB_TOKEN or GH_TOKEN.');
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
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
  req.on('error', reject);
});

const merge = (existing, fresh) => {
  const map = new Map(existing.map((entry) => [entry.timestamp, entry]));
  for (const item of fresh) map.set(item.timestamp, item);
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
};

const resolveGitConflictMarkers = (text) => {
  if (!text.includes('<<<<<<<') || !text.includes('>>>>>>>')) return text;
  const lines = text.split('\n');
  const resolved = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.startsWith('<<<<<<< ')) {
      resolved.push(line);
      idx += 1;
      continue;
    }

    idx += 1;
    const headChunk = [];
    while (idx < lines.length && !lines[idx].startsWith('=======')) {
      headChunk.push(lines[idx]);
      idx += 1;
    }

    if (idx < lines.length && lines[idx].startsWith('=======')) idx += 1;
    while (idx < lines.length && !lines[idx].startsWith('>>>>>>> ')) {
      idx += 1;
    }
    if (idx < lines.length && lines[idx].startsWith('>>>>>>> ')) idx += 1;

    resolved.push(...headChunk);
  }

  return resolved.join('\n');
};

const readHistoryJson = (historyPath) => {
  const raw = fs.readFileSync(historyPath, 'utf8');
  try {
    return { parsed: JSON.parse(raw), recovered: false };
  } catch (err) {
    if (raw.includes('<<<<<<< ') && raw.includes('=======') && raw.includes('>>>>>>> ')) {
      const resolved = resolveGitConflictMarkers(raw);
      try {
        return { parsed: JSON.parse(resolved), recovered: true };
      } catch (recoveryErr) {
        throw new Error(`Failed to recover conflicted JSON ${historyPath}: ${recoveryErr.message}`);
      }
    }
    throw err;
  }
};

const normalizeSeries = (series) => (Array.isArray(series)
  ? series.filter((entry) => entry && typeof entry.timestamp === 'string')
  : []);

const assertNoHistoryRegression = (existing, merged, seriesName, repo) => {
  if (!existing.length) return;

  const mergedTimestamps = new Set(merged.map((entry) => entry.timestamp));
  const missing = existing
    .map((entry) => entry.timestamp)
    .filter((timestamp) => !mergedTimestamps.has(timestamp));

  if (missing.length) {
    throw new Error(
      `${repo}: ${seriesName} history regression detected (missing timestamps: ${missing.slice(0, 5).join(', ')})`
    );
  }

  const existingFirst = existing[0]?.timestamp;
  const mergedFirst = merged[0]?.timestamp;
  if (existingFirst && mergedFirst && mergedFirst > existingFirst) {
    throw new Error(
      `${repo}: ${seriesName} history regression detected (first day moved from ${existingFirst} to ${mergedFirst})`
    );
  }

  if (merged.length < existing.length) {
    throw new Error(
      `${repo}: ${seriesName} history regression detected (entry count shrank from ${existing.length} to ${merged.length})`
    );
  }
};

const sumBy = (arr, key) => arr.reduce((acc, entry) => acc + (entry[key] || 0), 0);
const maxBy = (arr, key) => arr.reduce((acc, entry) => Math.max(acc, entry[key] || 0), 0);

const repoToFileSlug = (repo) => repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultHistoryPath = (repo) => `${historyDir}/${repoToFileSlug(repo)}.traffic.json`;

const ensureDir = (filePath) => {
  const dir = filePath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

async function syncRepo(item) {
  const repo = item.repo;
  if (!repo || !repo.includes('/')) {
    console.warn('Skipping invalid repo entry', item);
    return { repo: item.repo || 'unknown', changed: false, reason: 'invalid repo' };
  }
  if (Array.isArray(item.signals) && !item.signals.includes('traffic')) {
    return { repo, changed: false, reason: 'traffic disabled by config' };
  }

  const [owner, name] = repo.split('/');
  const historyPath = item.trafficPath || item.historyPath || defaultHistoryPath(repo);

  const [clonesRes, viewsRes, popularPathsRes, referrersRes] = await Promise.all([
    apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/clones`),
    apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/views`),
    apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/popular/paths`),
    apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/popular/referrers`),
  ]);

  let history = { repo, clones: [], views: [], popularPaths: [], referrers: [], totals: {}, lastUpdated: null };
  let hadPopularPaths = true;
  let hadReferrers = true;
  let recoveredConflictedHistory = false;
  if (fs.existsSync(historyPath)) {
    const read = readHistoryJson(historyPath);
    history = read.parsed;
    recoveredConflictedHistory = read.recovered;
    if (recoveredConflictedHistory) {
      console.warn(`Recovered conflicted history file for ${repo}: ${historyPath}`);
    }
    history.repo = history.repo || repo;
    if (!history.totals) history.totals = {};
    hadPopularPaths = Array.isArray(history.popularPaths);
    hadReferrers = Array.isArray(history.referrers);
    if (!history.popularPaths) history.popularPaths = [];
    if (!history.referrers) history.referrers = [];
  }

  history.clones = normalizeSeries(history.clones);
  history.views = normalizeSeries(history.views);

  const before = JSON.stringify({
    clones: history.clones,
    views: history.views,
    popularPaths: history.popularPaths,
    referrers: history.referrers,
  });
  const mergedClones = merge(history.clones || [], normalizeSeries(clonesRes.clones || []));
  const mergedViews = merge(history.views || [], normalizeSeries(viewsRes.views || []));
  assertNoHistoryRegression(history.clones, mergedClones, 'clones', repo);
  assertNoHistoryRegression(history.views, mergedViews, 'views', repo);
  history.clones = mergedClones;
  history.views = mergedViews;
  history.popularPaths = (popularPathsRes || []).map((entry) => ({
    path: entry.path,
    title: entry.title,
    count: entry.count || 0,
    uniques: entry.uniques || 0,
  }));
  history.referrers = (referrersRes || []).map((entry) => ({
    referrer: entry.referrer,
    count: entry.count || 0,
    uniques: entry.uniques || 0,
  }));

  console.log(`Fetched ${repo}: popularPaths=${history.popularPaths.length}, referrers=${history.referrers.length}`);

  const after = JSON.stringify({
    clones: history.clones,
    views: history.views,
    popularPaths: history.popularPaths,
    referrers: history.referrers,
  });

  const schemaBackfillNeeded = !hadPopularPaths || !hadReferrers;
  if (before === after && !schemaBackfillNeeded && !recoveredConflictedHistory) {
    return { repo, changed: false, historyPath };
  }

  history.totals = {
    clones: sumBy(history.clones, 'count'),
    uniqueClonerDays: sumBy(history.clones, 'uniques'),
    peakDailyClones: maxBy(history.clones, 'count'),
    peakDailyUniqueCloners: maxBy(history.clones, 'uniques'),
    views: sumBy(history.views, 'count'),
    uniqueVisitorDays: sumBy(history.views, 'uniques'),
    peakDailyViews: maxBy(history.views, 'count'),
    peakDailyUniqueVisitors: maxBy(history.views, 'uniques'),
    daysTracked: Math.max(history.clones.length, history.views.length),
    firstDay: history.clones[0]?.timestamp ?? history.views[0]?.timestamp ?? null,
    lastDay: history.clones[history.clones.length - 1]?.timestamp ?? history.views[history.views.length - 1]?.timestamp ?? null,
  };

  history.lastUpdated = new Date().toISOString();
  ensureDir(historyPath);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');
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
      const result = await syncRepo(item);
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

  console.log(`Sync completed. Changed repos: ${changed}/${repos.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});