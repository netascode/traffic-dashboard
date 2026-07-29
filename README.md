# GitHub Multi-Repo Traffic Dashboard

Interactive dashboard for GitHub traffic with:

- clones
- unique cloners (daily uniques)
- views
- unique visitors (daily uniques)
- repo/date/metric filters
- day/month/year aggregation
- current month and custom date range filters
- click-to-drill chart and period table

## Files

- `index.html`: dashboard UI.
- `scripts/merge-traffic-history.js`: per-repo history merge (adapted from your snippet).
- `scripts/sync-github-traffic.js`: pulls real traffic data from GitHub API for all configured repositories.
- `scripts/build-dashboard-data.js`: combines many repos into one dashboard dataset.
- `repos.json`: repository list used by the sync workflow.
- `.github/workflows/sync-traffic-dashboard.yml`: scheduled/manual central sync and aggregation workflow.
- `.github/workflows/deploy-pages.yml`: publishes dashboard to GitHub Pages.

## 1) Central repository list

Edit `repos.json`:

```json
{
  "repos": [
    { "repo": "netascode/nac-branch" },
    { "repo": "your-org/repo-2" }
  ]
}
```

## 2) Central GitHub token

Create a secret in this repository:

- `TRAFFIC_PAT`

The PAT must have access to all repos listed in `repos.json` and permission to call GitHub traffic endpoints.

## 3) Sync real data from GitHub API

Run locally (optional):

```bash
GITHUB_TOKEN=YOUR_TOKEN \
node scripts/sync-github-traffic.js \
  --config=repos.json \
  --historyDir=data/raw
```

This writes one history file per repo under `data/raw/`.
File naming is repo-based for clarity, for example `netascode/nac-branch` becomes `data/raw/netascode-nac-branch.traffic.json`.

Because sync runs on a schedule and merges daily windows into local history, you keep data far beyond GitHub's native 14-day traffic API limit.

Current schedule is daily (02:23 UTC) plus manual trigger.

## 4) Build ready-to-consume dataset

```bash
node scripts/build-dashboard-data.js \
  --config=repos.json \
  --historyDir=data/raw \
  --out=public/dashboard.json
```

## 5) Open the dashboard

Use VS Code Simple Browser or any static server and open:

- `traffic-dashboard/index.html`

The page reads `public/dashboard.json`.

## 6) Publish on GitHub Pages

The repository includes a Pages deployment workflow. To enable it:

1. GitHub repository Settings → Pages.
2. Under Build and deployment, choose Source = `GitHub Actions`.
3. Run workflow `Deploy Dashboard to GitHub Pages` once manually (or push to `main`).

After deployment, your dashboard is available from your repo's Pages URL.

## Optional per-repo merge script

If you still want to run collection jobs inside each source repository, this script is available:

Use this script inside each repo workflow after downloading `/tmp/clones.json` and `/tmp/views.json` from the GitHub traffic API:

```bash
node traffic-dashboard/scripts/merge-traffic-history.js \
  --history=data/traffic.json \
  --clones=/tmp/clones.json \
  --views=/tmp/views.json
```

It preserves historical days beyond the 14-day GitHub API window and recomputes totals each run.
