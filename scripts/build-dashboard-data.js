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
const defaultTrafficPath = (repo) => repo && repo.includes('/') ? `${historyDir}/${repoToFileSlug(repo)}.traffic.json` : null;
const defaultStarsPath = (repo) => repo && repo.includes('/') ? `${historyDir}/${repoToFileSlug(repo)}.stars.json` : null;
const defaultIssuesPath = (repo) => repo && repo.includes('/') ? `${historyDir}/${repoToFileSlug(repo)}.issues.json` : null;
const defaultRegistryPath = (repo) => repo && repo.includes('/') ? `${historyDir}/${repoToFileSlug(repo)}.registry.json` : null;

const readJsonIfExists = (path) => {
  if (!path || !fs.existsSync(path)) return null;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (err) { console.warn(`Failed to parse ${path}: ${err.message}`); return null; }
};

if (!fs.existsSync(configPath)) {
  console.error(`Missing config file: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const repos = [];
const community = { repos: [] };
const registry = { repos: [] };

for (const item of config.repos || []) {
  const trafficEnabled = !Array.isArray(item.signals) || item.signals.includes('traffic');
  const trafficPath = item.trafficPath || defaultTrafficPath(item.repo);
  const trafficData = trafficEnabled ? readJsonIfExists(trafficPath) : null;
  if (trafficData) {
    repos.push({
      repo: item.repo,
      owner: item.owner || null,
      name: item.name || null,
      lastUpdated: trafficData.lastUpdated || null,
      clones: trafficData.clones || [],
      views: trafficData.views || [],
      popularPaths: trafficData.popularPaths || [],
      referrers: trafficData.referrers || [],
      totals: trafficData.totals || null,
    });
  } else if (trafficEnabled) {
    console.warn(`Skipping traffic for ${item.repo || 'unknown'}: file not found (${trafficPath})`);
  }

  // Community signals: fold stars + issues if either present.
  const starsData = readJsonIfExists(item.starsPath || defaultStarsPath(item.repo));
  const issuesData = readJsonIfExists(item.issuesPath || defaultIssuesPath(item.repo));
  if (starsData || issuesData) {
    community.repos.push({
      repo: item.repo,
      group: item.group || 'modules',
      stars: starsData ? {
        snapshots: starsData.snapshots || [],
        totals: starsData.totals || {},
        lastUpdated: starsData.lastUpdated || null,
      } : null,
      issues: issuesData ? {
        totals: issuesData.totals || {},
        recentExternal: (issuesData.items || [])
          .filter((it) => it.is_org_member === false)
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, 20)
          .map((it) => ({
            number: it.number,
            type: it.type,
            state: it.state,
            author: it.author_login,
            created_at: it.created_at,
            closed_at: it.closed_at,
            merged_at: it.merged_at,
          })),
        lastPolledAt: issuesData.lastPolledAt || null,
      } : null,
    });
  }

  // Registry: only include repos with registry data on disk.
  const registryData = readJsonIfExists(item.registryPath || defaultRegistryPath(item.repo));
  if (registryData) {
    registry.repos.push({
      repo: item.repo,
      group: item.group || 'modules',
      type: registryData.type || (item.registry && item.registry.type) || null,
      registry: item.registry || null,
      snapshots: registryData.snapshots || [],
      totals: registryData.totals || {},
      lastUpdated: registryData.lastUpdated || null,
    });
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  repos,
  community,
  registry,
};

const outDir = outPath.split('/').slice(0, -1).join('/');
if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`Wrote ${outPath}: traffic=${repos.length}, community=${community.repos.length}, registry=${registry.repos.length}`);