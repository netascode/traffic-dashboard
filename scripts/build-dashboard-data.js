#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const configPath = getArg('--config', 'repos.json');
const outPath = getArg('--out', 'public/dashboard.json');
const historyDir = getArg('--historyDir', 'data/raw');

const repoToFileSlug = (repo) => repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultHistoryPath = (repo) => {
  if (!repo || !repo.includes('/')) return null;
  return `${historyDir}/${repoToFileSlug(repo)}.traffic.json`;
};

if (!fs.existsSync(configPath)) {
  console.error(`Missing config file: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const repos = [];

for (const item of config.repos || []) {
  const trafficPath = item.trafficPath || defaultHistoryPath(item.repo);
  if (!trafficPath || !fs.existsSync(trafficPath)) {
    console.warn(`Skipping ${item.repo || 'unknown'}: traffic file not found (${trafficPath})`);
    continue;
  }

  const data = JSON.parse(fs.readFileSync(trafficPath, 'utf8'));
  repos.push({
    repo: item.repo,
    owner: item.owner || null,
    name: item.name || null,
    lastUpdated: data.lastUpdated || null,
    clones: data.clones || [],
    views: data.views || [],
    popularPaths: data.popularPaths || [],
    referrers: data.referrers || [],
    totals: data.totals || null,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  repos,
};

const outDir = outPath.split('/').slice(0, -1).join('/');
if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`Wrote ${outPath} with ${repos.length} repositories.`);