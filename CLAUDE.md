# Rasmus Auctions — Field Operations Dashboard
## Claude Handoff / Project Context

---

## What This Is

A Node.js/Express single-page dashboard for Rasmus Auctions field operations. It syncs active auction deals from HubSpot, tracks identification and removal emails, manages site confirmations, and sends AI-drafted emails via Gmail. Deployed on Railway (free tier — in-memory state only, resets on redeploy).

**Live URL:** `https://rasmusopsdashboard-production.up.railway.app/`
**GitHub:** `https://github.com/dlestes1-cell/RasmusOpsDashboard`
**User:** Darren Estes (destes@rasmus.com) — field operations manager

---

## File Structure

```
server.js          — Express server, all REST routes, WebSocket broadcast, AI proxy
state.js           — In-memory store (projects, confirmations, alerts, leaderProjects, emailTracking)
utils.js           — uid(), now() helpers
tasks/
  scheduler.js     — All background tasks: HubSpot sync, email tracking, Gmail scan, daily digest
  gmail.js         — Gmail OAuth2 helper (getAccessToken, searchMessages, sendEmail, createDraft)
public/
  index.html       — Entire frontend: HTML + CSS + JS in one file (~1800 lines)
```

---

## Environment Variables (set in Railway)

| Variable | Purpose |
|---|---|
| `HUBSPOT_API_KEY` | HubSpot private app token |
| `ANTHROPIC_API_KEY` | Claude API for AI summaries/drafts |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth2 refresh token (destes@rasmus.com) |
| `ADMIN_TOKEN` | Optional — if set, all non-GET requests require `X-Admin-Token` header |
| `PORT` | Set by Railway automatically |

---

## HubSpot Integration

**Pipeline ID:** `147097136` (the main auction pipeline)

**Stage IDs:**
| Stage | ID |
|---|---|
| New Auction | (not tracked) |
| Identification | `249570210` |
| Auction Posting / Staffing | `1026748166` |
| Quality Control | `249570211` |
| Selling & Closing | `249570214` |
| Removal / Reconciliation | tracked as `status: 'removal'` |

**Key deal properties fetched:**
- `dealname`, `dealstage`, `pipeline`, `closedate`, `project_leader`, `hubspot_owner_id`
- `hs_date_entered_249570210` — date deal entered Identification stage (often null for active deals)
- `triage_poc` — who conducted triage (lives on the Prospect pipeline deal, not the auction deal — **cross-pipeline lookup not yet implemented**)

**Owner ID → Name map** (hardcoded in both `server.js` `/api/hubspot-active-projects` and `scheduler.js`):
The map includes ~27 staff members. Key field ops leaders:
- `76302559` → Darren Estes
- `84107196` → Luciana Castillo
- `84584819` → Karen Kester
- `84584840` → Werner Manrique-Martinez
- `89024581` → Blake Johnson
- `1613587974` → Kenneth Weaver

**Leader emails** (fetched dynamically from HubSpot owners API at startup, stored in `LEADER_EMAILS` in scheduler.js):
Used for Gmail scan matching and daily digest sends.

---

## Scheduler Tasks (tasks/scheduler.js)

Runs on startup + cron:

| Task | Schedule | Function |
|---|---|---|
| HubSpot sync | Every 5 min | `runHubSpotSync()` — syncs projects, confirmations, leader projects, email tracking |
| Confirmation check | Every 30 min | `runConfirmationCheck()` — flags overdue, checks Gmail for sent/replies |
| Email Gmail scan | Every 30 min | `runEmailGmailScan()` — scans sent mail for identification/removal emails, auto-marks sent |
| Daily digest | 8:10 AM | `runDailyDigest()` — sends per-leader email with their active jobs |
| Overdue draft | 9:00 AM | `runOverdueDraft()` — drafts Gmail email for overdue site confirmations |

Manual trigger endpoints (all POST):
- `/api/sync/trigger`
- `/api/email-scan/trigger`
- `/api/digest/trigger`
- `/api/overdue-draft/trigger`

---

## API Routes

### Projects
- `GET/POST /api/projects`
- `PATCH /api/projects/:id` — also writes `closedate` back to HubSpot
- `DELETE /api/projects/:id`
- `POST /api/projects/:id/log`

### Confirmations (Pending Site Confirmations)
- `GET/POST /api/confirmations`
- `PATCH/DELETE /api/confirmations/:id`
- `POST /api/confirmations/:id/send` — generates AI draft if none, sends via Gmail

### Email Tracking
- `GET /api/email-tracking`
- `PATCH/DELETE /api/email-tracking/:id`
- `POST /api/email-tracking/:id/send` — sends post-ID email via Gmail, marks entry sent

### Leader Projects
- `GET/POST /api/leader-projects`
- `PATCH/DELETE /api/leader-projects/:id`

### Alerts
- `DELETE /api/alerts/:id`

### AI
- `POST /api/ai/summary` — 2-sentence project status note
- `POST /api/ai/draft-email` — site confirmation email draft
- `POST /api/ai/et-draft` — post-identification email draft for seller

### HubSpot / Debug
- `GET /api/hubspot-active-projects` — deals in active stages grouped by project leader
- `GET /api/sync/pipelines` — all pipelines with stages
- `GET /api/sync/stages/:pipelineId`
- `GET /api/sync/debug` — raw deal properties for debugging
- `GET /api/sync/test-contact` — test contact association lookup

---

## Frontend (public/index.html)

Single file, ~1800 lines. No build step. Four tabs:

### Ops Tab (default)
- **Left column**: Active Projects (`#projectList`) — currently rendered by `renderHubspotProjects()` which calls `/api/hubspot-active-projects`. Also has `renderProjects()` for local state projects (local state projects are legacy/manual entries).
- **Right column** (420px fixed): Pending Site Confirmations (`#pendingPane`) — jobs awaiting post-auction site confirmation email. Each row has a `↗` HubSpot link (uses `e.hubspotId` stored on the confirmation object).
- Auction strip at top shows this-week's auctions.

### Project Leaders Tab
- Cards grouped by leader showing active/scheduled projects with timeline bars.

### Calendar Tab
- Monthly grid view of auction close dates.

### Email Tracking Tab
Two sections (Identification, Removal):
- Each unsent row has `✦ Draft` (generates AI post-ID email, opens modal with recipient input) and `✓ Mark Sent` buttons.
- Auto-detected sends show `⟳` prefix; manual marks show `✓`.

### Draft Modal
Shared modal (`#draftModal`) used for both confirmation drafts and ET drafts.
- For ET drafts: shows recipient input, calls `/api/ai/et-draft`, sends via `/api/email-tracking/:id/send`
- For confirmation drafts: calls `/api/ai/draft-email`, sends via `/api/confirmations/:id/send`

---

## State Schema

```javascript
// Project (from HubSpot sync or manual)
{ id, name, location, date, status, notes, stage, jobNumber, hubspotId,
  leader, idEnteredAt, removalEnteredAt, contactName, contactPhone, contactEmail,
  activityLog: [{ id, ts, text }], summaryText, createdAt }

// Confirmation (pending site confirmation)
{ id, site, recipient, project, completedAt, sent, flagged, draftText,
  hubspotId, removalDate, idDateSet, createdAt }

// Email Tracking entry
{ id, type: 'identification'|'removal', hubspotId, jobNumber, name, leader,
  triggeredAt, sent, sentAt, flagged, autoDetected }

// Leader Project
{ id, projectNumber, title, leader, startDate, removalDate, hubspotId, createdAt }

// Alert
{ id, type, message, projectId?, confirmationId?, ts }
```

---

## Known Issues / Pending Work

1. **Triage POC not shown on active projects**: `triage_poc` lives on the *Prospects* pipeline deal, not the active auction deal. Need to fetch associated Prospect deal per auction deal and join `triage_poc`. Prospects pipeline ID unknown — need to hit `/api/sync/pipelines` on Railway to get it.

2. **`hs_date_entered_249570210` returns null** for most active deals from HubSpot. So `triggeredAt` is null on most email tracking entries, showing "Date Unknown". The Gmail scan auto-detects sent emails by job number in subject line and fills in the real send timestamp.

3. **In-memory state resets on Railway redeploy**. Upgrade path: replace `state.js` with a pg-backed equivalent. All reads/writes go through exported functions so nothing else changes.

4. **Admin token (ADMIN_TOKEN)**: Server-side middleware exists and blocks non-GET without the token. Client-side injection of `X-Admin-Token` header is not implemented — all fetches from the browser go through without auth.

5. **Double import in server.js** (line 7-8): `state` is required as a module AND destructured again. Minor, doesn't break anything.

---

## CSS Variables (theme)

```css
--bg: #0e0d0b         /* near-black */
--surface: #141210    /* dark card bg */
--surface2: #1a1814   /* slightly lighter */
--surface3: #252418   /* hover state */
--border: #2a2620
--text: #e8e0d0       /* warm off-white */
--text-mid: #b8ad9e
--text-dim: #7a7568
--gold: #c8a84b       /* primary accent */
--gold-dim: #8a6e2a
--red: #c44a3a
--amber: #c89a4b
--green: #4a9e6a
--blue: #4b8fc8
--serif: 'Georgia', serif
--mono: 'Courier New', monospace
--sans: system-ui, sans-serif
```

---

## Dev

```bash
npm run dev    # node --watch server.js, port 3000
npm test       # jest (43 tests covering state + scheduler)
```
