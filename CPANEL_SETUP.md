# Parlay King V3 Titan XII — Namecheap cPanel Deployment Guide

## Your Hosting Details

| Setting | Value |
|---|---|
| **Domain** | soccernbaparlayking.vip |
| **cPanel URL** | https://server185.web-hosting.com/cpanel |
| **cPanel Username** | soccsbur |
| **Server IP** | 198.54.115.65 |
| **FTP Port** | 21 (Passive) |
| **SFTP Port** | 21098 |

---

## Step 1 — Upload the ZIP via cPanel File Manager

1. Log in to **https://server185.web-hosting.com/cpanel**
2. Open **File Manager** → navigate to `public_html` (or a subdirectory if preferred)
3. Click **Upload** → select `parlay-king-cpanel.zip`
4. Once uploaded, right-click the ZIP → **Extract**
5. All files will appear in the current directory

---

## Step 2 — Set Up Node.js App in cPanel

1. In cPanel, find **"Setup Node.js App"** (under Software section)
2. Click **"Create Application"**
3. Fill in:
   - **Node.js version:** 20.x (or highest available)
   - **Application mode:** Production
   - **Application root:** `public_html` (or wherever you extracted the ZIP)
   - **Application URL:** `soccernbaparlayking.vip`
   - **Application startup file:** `app.js`
4. Click **Create**

---

## Step 3 — Configure Environment Variables

In the Node.js App setup page, scroll to **"Environment Variables"** and add:

| Variable | Value |
|---|---|
| `PORT` | (leave blank — cPanel sets this automatically) |
| `NODE_ENV` | `production` |
| `TZ` | `America/Halifax` |
| `SESSION_SECRET` | `Zk5fL/zhGg4eDOn4XZbAZkdeMhIUO7Au9SnsKAeTLjd1Tvo2hqrKAS5E1j0mKHB5r3YhZZNPiNUnW8ofIDnj8Q==` |
| `DATABASE_URL` | `postgresql://neondb_owner:npg_WPim3gY4lKTj@ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require` |
| `PGHOST` | `ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech` |
| `PGPORT` | `5432` |
| `PGDATABASE` | `neondb` |
| `PGUSER` | `neondb_owner` |
| `PGPASSWORD` | `npg_WPim3gY4lKTj` |
| `API_FOOTBALL_KEY` | `71614ef3fd222860db4bc46a4edc3591` |
| `ODDS_API_KEY` | `e780bee8f11d6859d3d5a99ca8549fff` |
| `SFTP_HOST` | `server185.web-hosting.com` |
| `SFTP_USERNAME` | `soccsbur` |
| `SFTP_PASSWORD` | `EVQEsUXk7NHt` |
| `SFTP_PORT` | `21` |

---

## Step 4 — Install Dependencies & Start

In the Node.js App panel:

1. Click **"Run NPM Install"** — this installs all dependencies from `package.json`
2. Click **"Start App"** (or **Restart** if already running)
3. Visit `http://soccernbaparlayking.vip/admin` to confirm the admin panel loads

---

## Step 5 — Verify Everything Works

| URL | Expected Result |
|---|---|
| `http://soccernbaparlayking.vip/` | Admin login page |
| `http://soccernbaparlayking.vip/admin` | Admin login page |
| `http://soccernbaparlayking.vip/healthz` | `{"status":"ok","ready":true,...}` |
| `http://soccernbaparlayking.vip/api/health` | Full health JSON |

**Admin Passwords:** `Parlayking` or `386Leblanc`

---

## Important Notes for Namecheap Shared Hosting

### PORT Binding
The app uses `process.env.PORT` — cPanel's Node.js manager sets this automatically. You do **not** need to set PORT manually.

### Always-On / No Cold Starts
cPanel's Node.js app manager keeps the process running. If it crashes, restart it from the cPanel panel. For true 24/7 uptime on shared hosting, enable **"Auto-restart"** if available in your plan.

### Cron Jobs (Daily Pick Generation)
The app has a built-in scheduler that runs at 1:00 AM AST daily. If cPanel's Node.js manager doesn't support persistent background processes, you can also trigger generation manually from the Admin → Control panel, or set up a cPanel Cron Job to hit:
```
curl -X POST http://soccernbaparlayking.vip/api/admin/trigger \
  -H "Content-Type: application/json" \
  -d '{"password":"Parlayking","date":"YYYY-MM-DD"}'
```

### API Cache
The app caches all API-Football responses for 1 hour to protect your 100 req/day quota. Cache is stored in `/tmp/parlay-king-cache/` and clears on server restart. You can also clear it manually from Admin → Control → "Refresh Data".

### Database
Your NeonDB PostgreSQL database is hosted externally at Neon.tech — no local database setup needed. The connection is already configured.

---

## File Structure in ZIP

```
parlay-king-cpanel/
├── app.js                    ← Main entry point (pre-built bundle)
├── package.json              ← Dependencies
├── .env.example              ← Environment variable template
├── CPANEL_SETUP.md           ← This guide
├── server/
│   ├── templates/
│   │   └── admin.html        ← Admin dashboard UI
│   └── apis/
│       └── apiFootball.ts    ← API-Football integration (source)
├── shared/
│   └── schema.ts             ← Database schema (source)
└── scripts/
    └── build.js              ← Build script (to rebuild if needed)
```

> **Note:** `app.js` is the pre-built production bundle — you do NOT need to run `npm run build` unless you modify the source files.
