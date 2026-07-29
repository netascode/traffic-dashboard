#!/usr/bin/env node
const fs = require('fs');
const https = require('https');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const configPath = getArg('--config', 'repos.json');
const historyDir = getArg('--historyDir', '.metrics/repos');
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

const sumBy = (arr, key) => arr.reduce((acc, entry) => acc + (entry[key] || 0), 0);
const maxBy = (arr, key) => arr.reduce((acc, entry) => Math.max(acc, entry[key] || 0), 0);

const defaultHistoryPath = (repo) => `${historyDir}/${repo.replace('/', '--')}.traffic.json`;

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

  const [owner, name] = repo.split('/');
  const historyPath = item.trafficPath || item.historyPath || defaultHistoryPath(repo);

  const clonesRes = await apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/clones`);
  const viewsRes = await apiGet(`https://api.github.com/repos/${owner}/${name}/traffic/views`);

  let history = { clones: [], views: [], totals: {}, lastUpdated: null };
  if (fs.existsSync(historyPath)) {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!history.totals) history.totals = {};
  }

  const before = JSON.stringify({ clones: history.clones, views: history.views });
  history.clones = merge(history.clones || [], clonesRes.clones || []);
  history.views = merge(history.views || [], viewsRes.views || []);
  const after = JSON.stringify({ clones: history.clones, views: history.views });

  if (before === after) {
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