import http from 'http';
import { AddressInfo } from 'net';

const PORT = parseInt(process.env.PORT || '8080', 10);
const TZ = process.env.TZ || 'America/Moncton';
process.env.TZ = TZ;

// ─── PHASE 1: Raw HTTP server for instant health checks ───────────────────────
// This binds to the port IMMEDIATELY before Express loads, preventing cold-start
// 500 errors. Any health check hitting the port gets "OK" right away.
let serverFullyReady = false;
let expressApp: any = null;

const rawServer = http.createServer((req, res) => {
  const url = req.url || '/';

  // Health check endpoints — always respond instantly
  if (url === '/healthz' || url === '/health' || url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      ready: serverFullyReady,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: 'V3 Titan XII'
    }));
    return;
  }

  if (url === '/' && req.headers['user-agent'] && !req.headers['user-agent'].includes('Mozilla')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Once Express is ready, hand off all requests
  if (serverFullyReady && expressApp) {
    expressApp(req, res);
    return;
  }

  // During startup, return 200 for health probes, 503 for everything else
  if (url.startsWith('/api/') || url === '/') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting', message: 'Server initializing...' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Parlay King is starting up...</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
});

rawServer.listen(PORT, '0.0.0.0', () => {
  const addr = rawServer.address() as AddressInfo;
  console.log(`[${new Date().toISOString()}] Raw HTTP server bound to port ${addr.port}`);
  console.log(`[${new Date().toISOString()}] Initializing Express + Scheduler...`);
  initializeExpress();
});

// ─── PHASE 2: Full Express initialization ─────────────────────────────────────
async function initializeExpress() {
  try {
    const dotenv = await import('dotenv');
    dotenv.config();

    const express = (await import('express')).default;
    const session = (await import('express-session')).default;
    const cors = (await import('cors')).default;
    const path = await import('path');
    const fs = await import('fs');

    const app = express();

    // Trust proxy (for reverse proxies / load balancers)
    app.set('trust proxy', 1);

    // CORS
    app.use(cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
    }));

    // Body parsers
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Session
    app.use(session({
      secret: process.env.SESSION_SECRET || 'parlay-king-secret-2025',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: 'lax',
      },
    }));

    // Health endpoints on Express too
    app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
    app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
    app.get('/api/health', (req, res) => res.json({
      status: 'ok',
      ready: true,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: 'V3 Titan XII',
      scheduler: 'active',
    }));

    // SEO routes — MUST be registered before static middleware so /sitemap.xml
    // and /robots.txt are served correctly and not intercepted by express.static
    try {
      const { registerSeoRoutes } = await import('./seo.js');
      registerSeoRoutes(app);
      console.log('[SEO] Module loaded and routes registered successfully');
    } catch (seoErr) {
      console.error('[SEO] FAILED to register SEO routes:', seoErr);
      // Fallback: register sitemap inline if seo.ts fails
      app.get('/sitemap.xml', (_req: any, res: any) => {
        const today = new Date().toISOString().split('T')[0];
        const pages = ['/', '/picks', '/soccer-picks', '/nba-picks', '/parlays', '/results', '/vip', '/pro'];
        const urls = pages.map(p => `<url><loc>https://soccernbaparlayking.vip${p}</loc><lastmod>${today}</lastmod><priority>0.9</priority></url>`).join('');
        res.setHeader('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
      });
      app.get('/robots.txt', (_req: any, res: any) => {
        res.setHeader('Content-Type', 'text/plain');
        res.send('User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: https://soccernbaparlayking.vip/sitemap.xml\n');
      });
      console.log('[SEO] Fallback sitemap/robots routes registered');
    }

    // Serve built Expo admin app from /dist
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }

    // Template paths
    const adminHtmlPath = path.join(process.cwd(), 'server/templates/admin.html');
    const clientHtmlPath = path.join(process.cwd(), 'server/templates/client.html');

    // ── PUBLIC SITE — root and all public pages ──
    app.get('/', (req, res) => {
      const ua = req.headers['user-agent'] || '';
      if (!ua.includes('Mozilla')) return res.send('OK');
      if (fs.existsSync(clientHtmlPath)) return res.sendFile(clientHtmlPath);
      res.redirect('/picks');
    });

    // Public pages — all serve the client SPA
    const publicPages = ['/picks', '/soccer-picks', '/nba-picks', '/parlays', '/results', '/vip', '/pro'];
    publicPages.forEach(page => {
      app.get(page, (_req: any, res: any) => {
        if (fs.existsSync(clientHtmlPath)) return res.sendFile(clientHtmlPath);
        res.redirect('/');
      });
    });

    app.get('/admin', (req, res) => {
      if (fs.existsSync(adminHtmlPath)) {
        return res.sendFile(adminHtmlPath);
      }
      res.send(getAdminFallbackHtml());
    });

    app.get('/master-control', (req, res) => {
      if (fs.existsSync(adminHtmlPath)) {
        return res.sendFile(adminHtmlPath);
      }
      res.send(getAdminFallbackHtml());
    });

    app.get('/recovery', (req, res) => {
      const recoveryPath = path.join(process.cwd(), 'server/templates/recovery.html');
      if (fs.existsSync(recoveryPath)) {
        return res.sendFile(recoveryPath);
      }
      res.send('<html><body><h2>Recovery Mode</h2><p>System is operational.</p></body></html>');
    });

    // Load all API routes
    const { registerRoutes } = await import('./routes.js');
    await registerRoutes(app);

    // SPA fallback — public pages get client.html, /admin paths get admin.html
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
      }
      // Admin paths
      if (req.path.startsWith('/admin') || req.path.startsWith('/master-control') || req.path.startsWith('/dashboard') || req.path.startsWith('/recovery')) {
        if (fs.existsSync(adminHtmlPath)) return res.sendFile(adminHtmlPath);
        return res.send(getAdminFallbackHtml());
      }
      // All other paths → public client site
      if (fs.existsSync(clientHtmlPath)) return res.sendFile(clientHtmlPath);
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
      res.send(getAdminFallbackHtml());
    });

    // Attach Express to raw server
    expressApp = app;
    serverFullyReady = true;

    console.log(`[${new Date().toISOString()}] Express fully initialized and ready`);

    // Start scheduler
    try {
      const { startScheduler } = await import('./scheduler.js');
      startScheduler();
      console.log(`[${new Date().toISOString()}] Scheduler started`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Scheduler failed to start:`, err);
    }

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Fatal error during Express init:`, err);
    // Don't crash — raw server still handles health checks
  }
}

function getAdminFallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Parlay King Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; padding: 40px; }
    .trophy { font-size: 64px; margin-bottom: 20px; }
    h1 { font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #FFD700; margin-bottom: 8px; }
    p { color: #888; margin-bottom: 30px; }
    .badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(255,215,0,0.1); border: 1px solid rgba(255,215,0,0.3); border-radius: 20px; padding: 8px 16px; color: #FFD700; font-size: 13px; margin: 4px; }
    input { width: 300px; padding: 14px 18px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,215,0,0.3); border-radius: 8px; color: #fff; font-size: 16px; margin-bottom: 12px; display: block; margin: 0 auto 12px; }
    button { background: linear-gradient(135deg, #FFD700, #FFA500); color: #000; border: none; padding: 14px 40px; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; letter-spacing: 1px; }
    .status { margin-top: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="trophy">🏆</div>
    <h1>PARLAY KING</h1>
    <p>Gold Standard V3 Titan XII — Admin Control</p>
    <div style="margin-bottom: 30px;">
      <span class="badge">📊 87.5% Win Rate</span>
      <span class="badge">⚡ Gold Standard V3 Titan XII</span>
      <span class="badge">🟢 24/7 Automated</span>
    </div>
    <label style="color:#888;font-size:12px;letter-spacing:2px;display:block;margin-bottom:8px;">ADMIN PASSWORD</label>
    <input type="password" id="pw" placeholder="Enter password" />
    <button onclick="login()">🛡️ ACCESS COMMAND CENTER</button>
    <div class="status" id="status"></div>
  </div>
  <script>
    async function login() {
      const pw = document.getElementById('pw').value;
      const st = document.getElementById('status');
      st.textContent = 'Authenticating...';
      try {
        const r = await fetch('/api/admin/login', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({password: pw})
        });
        const d = await r.json();
        if (d.token) {
          localStorage.setItem('adminToken', d.token);
          st.textContent = 'Access granted! Redirecting...';
          window.location.href = '/dashboard';
        } else {
          st.textContent = 'Invalid password';
          st.style.color = '#ff4444';
        }
      } catch(e) {
        st.textContent = 'Connection error: ' + e.message;
        st.style.color = '#ff4444';
      }
    }
    document.getElementById('pw').addEventListener('keypress', e => { if(e.key==='Enter') login(); });
  </script>
</body>
</html>`;
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Graceful shutdown initiated');
  rawServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[SIGINT] Graceful shutdown initiated');
  rawServer.close(() => process.exit(0));
});
