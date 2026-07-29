#!/usr/bin/env node
const fs = require('fs');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const historyPath = getArg('--history', 'data/traffic.json');
const clonesPath = getArg('--clones', '/tmp/clones.json');
const viewsPath = getArg('--views', '/tmp/views.json');

const ensureDir = (filePath) => {
  const dir = filePath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const merge = (existing, fresh) => {
  const map = new Map(existing.map((entry) => [entry.timestamp, entry]));
  for (const item of fresh) map.set(item.timestamp, item);
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
};

const sumBy = (arr, key) => arr.reduce((acc, entry) => acc + (entry[key] || 0), 0);
const maxBy = (arr, key) => arr.reduce((acc, entry) => Math.max(acc, entry[key] || 0), 0);

let history = { clones: [], views: [], totals: {}, lastUpdated: null };
if (fs.existsSync(historyPath)) {
  history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  if (!history.totals) history.totals = {};
}

const newClones = JSON.parse(fs.readFileSync(clonesPath, 'utf8'));
const newViews = JSON.parse(fs.readFileSync(viewsPath, 'utf8'));

const before = JSON.stringify({ clones: history.clones, views: history.views });

history.clones = merge(history.clones, newClones);
history.views = merge(history.views, newViews);

const after = JSON.stringify({ clones: history.clones, views: history.views });
if (before === after) {
  console.log('No new data since last run; skipping write to avoid empty commit.');
  process.exit(0);
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
console.log(`Updated ${historyPath}`);