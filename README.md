# Rasmus Auctions — Field Operations Dashboard

Real-time project tracking and post-project site email confirmation dashboard.
Runs on Railway. WebSocket push updates. Scheduled tasks run server-side.

---

## Stack
- **Express** — HTTP server + REST API
- **ws** — WebSocket server (pushes state to all connected browsers instantly)
- **node-cron** — scheduled background tasks
- **In-memory state** — no database required (free Railway tier)

---

## Local setup (Claude Code)

```bash
cd rasmus-dashboard
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run dev
# Open http://localhost:3000
```

---

## Deploy to Railway

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
gh repo create rasmus-dashboard --private --push --source=.
# or: git remote add origin https://github.com/YOU/rasmus-dashboard.git && git push -u origin main
```

### 2. Create Railway project
1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select your `rasmus-dashboard` repo
3. Railway auto-detects Node.js via `railway.toml` and runs `node server.js`

### 3. Set environment variable
In Railway → your service → Variables tab:
```
ANTHROPIC_API_KEY = sk-ant-xxxxxxxxxx
```
This keeps your API key server-side — it's never exposed to the browser.

### 4. Get your public URL
Railway → your service → Settings → Networking → Generate Domain
Your dashboard is now live at `https://rasmus-dashboard-xxxx.railway.app`

---

## Scheduled Tasks (run automatically on server)

| Task | Schedule | What it does |
|---|---|---|
| Confirmation check | Every 5 minutes | Flags confirmations approaching or past 24h window, creates alerts |
| AI project scan | Every 6 hours | Runs Claude on all at-risk/needs-attention projects, updates summaries |

Both tasks also run once on server startup.

---

## Upgrade path: Add Postgres persistence

When you upgrade Railway to a paid plan:
1. Add a Postgres plugin in Railway
2. Replace `state.js` with a `pg`-backed version
3. All API routes and tasks stay the same — they only call state.js functions

---

## Re-deploy after changes

```bash
git add . && git commit -m "update" && git push
```
Railway auto-deploys on every push. Zero downtime redeploys.
