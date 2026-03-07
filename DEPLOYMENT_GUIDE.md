# Parlay King — Gold Standard V3 Titan XII
## Always-On Deployment Guide

---

## Live Access

| Resource | URL |
|---|---|
| **Admin Dashboard** | https://8080-ijd59rpz6gs89ueils5pf-281f510d.us2.manus.computer/admin |
| **Health Check** | https://8080-ijd59rpz6gs89ueils5pf-281f510d.us2.manus.computer/healthz |
| **API Health** | https://8080-ijd59rpz6gs89ueils5pf-281f510d.us2.manus.computer/api/health |

---

## Admin Credentials

| Password | Works? |
|---|---|
| `Parlayking` | ✅ Production |
| `386Leblanc` | ✅ Production |
| `admin123` | ✅ Dev fallback |

---

## What Was Fixed (vs. Replit)

| Problem on Replit | Solution Applied |
|---|---|
| Cold start 500 errors | Raw HTTP server binds to port **immediately** before Express loads — health checks always return 200 |
| Port binding issues | Explicit `0.0.0.0` binding, no IP restrictions |
| Process sleeping/hibernating | **PM2** process manager keeps the server alive 24/7 with auto-restart on crash |
| Scheduler stopping | node-cron scheduler starts inside Express, persists in PM2 daemon |
| Keep-alive ping | Built-in 5-minute self-ping cron job inside the scheduler |
| Memory leaks | PM2 configured to restart if memory exceeds 512MB |

---

## Architecture

```
Port 8080 (always bound)
    │
    ├── Raw HTTP Server (instant health checks, no cold start)
    │       ├── /healthz  → 200 OK immediately
    │       ├── /health   → 200 OK immediately
    │       └── All other requests → forwarded to Express once ready
    │
    └── Express.js (loads asynchronously after port is bound)
            ├── /admin          → Admin Dashboard HTML
            ├── /api/admin/*    → Protected admin endpoints
            ├── /api/health     → Health status
            └── /api/bet-builder/games → Public picks API
```

---

## Scheduler Schedule (AST — America/Halifax)

| Time | Job |
|---|---|
| 1:00 AM | Primary pick generation |
| 1:30 AM | Retry 1 (if primary failed) |
| 2:00 AM | Retry 2 |
| 2:30 AM | Retry 3 |
| 3:00 AM | Final retry |
| Every 5 min | Keep-alive self-ping |
| 11:00 AM | NBA props refresh |
| 6:00 PM | Evening data refresh |
| 11:59 PM | Daily audit report |

---

## Environment Variables

All secrets are stored in `/home/ubuntu/parlay-king/.env`. To update:

```bash
cd /home/ubuntu/parlay-king
nano .env
# Edit the values, then:
node scripts/build.js && pm2 restart parlay-king
```

### Variables Still Needed (Placeholders)

| Variable | Status | Where to Find |
|---|---|---|
| `SESSION_SECRET` | Placeholder — needs full value | Replit Secrets panel (lock icon) |
| `API_FOOTBALL_KEY` | Placeholder — needs full value | Replit Secrets panel |
| `ODDS_API_KEY` | Empty | Replit Secrets panel (.replit file) |
| `SFTP_PASSWORD` | Empty | Replit Secrets panel |

---

## PM2 Commands

```bash
# Check status
pm2 status

# View live logs
pm2 logs parlay-king

# Restart server
pm2 restart parlay-king

# Rebuild and restart
cd /home/ubuntu/parlay-king && node scripts/build.js && pm2 restart parlay-king

# Stop server
pm2 stop parlay-king
```

---

## Database

Connected to your existing **NeonDB PostgreSQL** instance. All 13 tables were created:

- `picks` — Daily predictions
- `results` — W/L records
- `run_logs` — Scheduler execution history
- `members` — Member tracking
- `member_heartbeats` — Active user tracking
- `parlays` — Parlay legs
- `system_alerts` — System notifications
- `engine_config` — V3 Titan XII model weights
- `tier_pricing` — Subscription pricing
- `audit_reports` — Weekly performance reports
- `player_stats` — Player statistics cache
- `users` — Admin users
- `parlays` — Parlay data

---

## Admin Dashboard Features

| Section | Description |
|---|---|
| **Dashboard** | Live win rate, scheduler status, recent runs |
| **Engine** | 12-factor weight visualization, live fixture validator |
| **Picks** | Today's picks with confidence bars, tier labels |
| **Parlays** | Today's parlay legs |
| **W/L Records** | Full result history with win rate |
| **Tier Results** | Per-tier (Free/VIP/Pro) hit rates |
| **Members** | Member list, active users in last 15 min |
| **Tier Pricing** | Edit subscription prices |
| **Site & FTP** | File manager for soccernbaparlayking.vip |
| **Control** | Manual engine trigger, lock toggle, SEO ping |
| **Alerts** | System notifications |
