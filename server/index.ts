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
        const pages = ['/', '/picks', '/soccer-picks', '/nba-picks', '/parlays', '/results', '/vip', '/pro', '/match/atalanta-vs-bayern-munich'];
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
    // Helper: build enriched SportsEvent JSON-LD from a pick object
    function buildSportsEventSchema(p: any, date: string): object {
      const homeTeam = p.homeTeam || p.home_team || '';
      const awayTeam = p.awayTeam || p.away_team || '';
      const sport = (p.sport || 'basketball').toLowerCase();
      const isSoccer = sport === 'soccer' || sport === 'mls' || sport === 'football';
      const sportLabel = isSoccer ? 'Soccer' : 'Basketball';
      const defaultTime = isSoccer ? 'T19:00:00-05:00' : 'T19:30:00-05:00';
      const gameTime = (p.metadata as any)?.gameTime || '';
      // Parse gameTime like '3:30 PM ET' into ISO
      let startDate = date + defaultTime;
      if (gameTime) {
        const m = gameTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (m) {
          let h = parseInt(m[1]); const min = m[2]; const ampm = m[3].toUpperCase();
          if (ampm === 'PM' && h !== 12) h += 12;
          if (ampm === 'AM' && h === 12) h = 0;
          startDate = `${date}T${String(h).padStart(2,'0')}:${min}:00-05:00`;
        }
      }
      const startMs = new Date(startDate).getTime();
      const endDate = new Date(startMs + 3 * 60 * 60 * 1000).toISOString();
      const image = isSoccer
        ? 'https://soccernbaparlayking.vip/images/parlay-king-logo.png'
        : 'https://soccernbaparlayking.vip/images/knicks-lakers-hero.jpg';
      return {
        '@type': 'SportsEvent',
        'name': `${homeTeam} vs ${awayTeam}`,
        'startDate': startDate,
        'endDate': endDate,
        'eventStatus': 'https://schema.org/EventScheduled',
        'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
        'sport': sportLabel,
        'description': (p.metadata as any)?.recommendation || `${p.prediction || p.pick} at ${Math.round(p.confidence ?? 0)}% confidence.`,
        'image': { '@type': 'ImageObject', 'url': image, 'width': 1200, 'height': 630 },
        'performer': [
          { '@type': 'SportsTeam', 'name': homeTeam, 'sport': sportLabel },
          { '@type': 'SportsTeam', 'name': awayTeam, 'sport': sportLabel },
        ],
        'organizer': { '@type': 'Organization', 'name': 'Parlay King', 'url': 'https://soccernbaparlayking.vip' },
        'offers': {
          '@type': 'Offer',
          'url': 'https://soccernbaparlayking.vip/pricing',
          'price': '0',
          'priceCurrency': 'USD',
          'availability': 'https://schema.org/InStock',
          'validFrom': date,
        },
        'homeTeam': { '@type': 'SportsTeam', 'name': homeTeam, 'sport': sportLabel },
        'awayTeam': { '@type': 'SportsTeam', 'name': awayTeam, 'sport': sportLabel },
      };
    }

    app.get('/', async (req, res) => {
      const ua = req.headers['user-agent'] || '';
      if (!ua.includes('Mozilla')) return res.send('OK');
      if (!fs.existsSync(clientHtmlPath)) return res.redirect('/picks');

      try {
        // Build enriched SportsEvent schema from today's live picks (server-side for Googlebot)
        const { storage } = await import('./storage.js');
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
        const picks = await storage.getPicksByDate(date);
        const activePicks = picks.filter((p: any) => !p.isDisabled && (p.confidence ?? 0) >= 68 && p.tier !== 'free');
        const topPicks = activePicks.slice(0, 4);

        if (topPicks.length > 0) {
          const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Moncton' });
          const eventSchemas = topPicks.map((p: any) => buildSportsEventSchema(p, date));
          const dynamicSchema = {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            'name': `Expert Sports Picks — ${today}`,
            'description': `Today's top ${topPicks.length} expert picks from Parlay King Gold Standard V3 Titan XII.`,
            'url': 'https://soccernbaparlayking.vip',
            'numberOfItems': topPicks.length,
            'itemListElement': eventSchemas.map((ev: any, i: number) => ({
              '@type': 'ListItem',
              'position': i + 1,
              'item': ev,
            })),
          };
          const schemaTag = `<script type="application/ld+json">${JSON.stringify(dynamicSchema)}</script>`;
          let html = fs.readFileSync(clientHtmlPath, 'utf8');
          // Inject dynamic schema right after <head>
          html = html.replace('<head>', `<head>\n${schemaTag}`);
          res.setHeader('Content-Type', 'text/html');
          return res.send(html);
        }
      } catch (e) {
        // Fall through to static file if schema injection fails
      }

      return res.sendFile(clientHtmlPath);
    });

    // ── Match Preview Pages — SEO-optimized dedicated pages ──────────────────────────────
    const matchHtmlPath = path.join(process.cwd(), 'server/templates/match-atalanta-vs-bayern.html');
    app.get('/match/atalanta-vs-bayern-munich', (_req: any, res: any) => {
      if (fs.existsSync(matchHtmlPath)) return res.sendFile(matchHtmlPath);
      res.redirect('/');
    });
    // Alias for common search query variants
    app.get('/match/atalanta-vs-bayern', (_req: any, res: any) => res.redirect(301, '/match/atalanta-vs-bayern-munich'));
    app.get('/match/atalanta-bayern-munich', (_req: any, res: any) => res.redirect(301, '/match/atalanta-vs-bayern-munich'));
    console.log('[SEO] Match preview route registered: /match/atalanta-vs-bayern-munich');

    // Public pages — all serve the client SPA
    const publicPages = [
      '/picks', '/soccer-picks', '/nba-picks', '/parlays', '/results', '/vip', '/pro',
      '/register', '/login', '/account', '/pricing', '/faq', '/chat',
      '/analytics', '/member-dashboard',
    ];
    publicPages.forEach(page => {
      app.get(page, (_req: any, res: any) => {
        if (fs.existsSync(clientHtmlPath)) return res.sendFile(clientHtmlPath);
        res.redirect('/');
      });
    });

    // ── PayPal Compliance Legal Pages ───────────────────────────────────────────────────────
    const legalStyle = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#0a0e1a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;line-height:1.7;padding:0}
        .header{background:#111827;border-bottom:2px solid #f5a623;padding:16px 24px;display:flex;align-items:center;gap:16px}
        .header a{color:#f5a623;text-decoration:none;font-weight:700;font-size:1.1rem}
        .header span{color:#888;font-size:.9rem}
        .container{max-width:860px;margin:40px auto;padding:0 24px 60px}
        h1{color:#f5a623;font-size:2rem;margin-bottom:8px}
        h2{color:#f5a623;font-size:1.2rem;margin:32px 0 10px}
        p,li{color:#ccc;margin-bottom:10px;font-size:.95rem}
        ul{padding-left:20px;margin-bottom:16px}
        .disclaimer-box{background:#1a1a2e;border:1px solid #f5a623;border-radius:8px;padding:16px;margin:20px 0}
        .disclaimer-box p{color:#f5a623;font-weight:600;margin:0}
        .footer{text-align:center;color:#555;font-size:.8rem;margin-top:40px;padding-top:20px;border-top:1px solid #222}
        a{color:#f5a623}
      </style>`;

    app.get('/terms', (_req: any, res: any) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms of Service | Soccer NBA Parlay King</title>${legalStyle}</head><body>
        <div class="header"><a href="/">⚽ Soccer NBA Parlay King</a><span>/</span><span>Terms of Service</span></div>
        <div class="container">
          <h1>Terms of Service</h1>
          <p><strong>Last Updated: March 8, 2026</strong></p>
          <div class="disclaimer-box"><p>⚠️ All picks and predictions are for informational and entertainment purposes only. We do not guarantee any winnings or profits. Sports betting may not be legal in your jurisdiction — check your local laws before placing any bets.</p></div>
          <h2>1. Acceptance of Terms</h2>
          <p>By accessing or using soccernbaparlayking.vip (the “Site”), you agree to be bound by these Terms of Service. If you do not agree, please do not use the Site.</p>
          <h2>2. Nature of Service</h2>
          <p>Soccer NBA Parlay King provides sports analysis, picks, and predictions for informational and entertainment purposes only. We are a sports information service — we do not accept bets, operate as a sportsbook, or facilitate gambling of any kind. All content is opinion-based analysis generated by the Titan XII V3 prediction engine.</p>
          <h2>3. Subscription Plans</h2>
          <p>We offer the following subscription tiers:</p>
          <ul>
            <li><strong>Free Tier:</strong> Limited daily picks (64–67% confidence) at no cost.</li>
            <li><strong>Pro Monthly:</strong> Full access to 70%+ confidence picks, billed monthly. Recurring billing — you will be charged the same amount each billing cycle until cancelled.</li>
            <li><strong>Lifetime Access:</strong> One-time payment for permanent access to all 68%+ confidence picks.</li>
          </ul>
          <h2>4. Billing and Payments</h2>
          <p>Payments are processed securely via PayPal. By subscribing to a paid plan, you authorize us to charge your payment method on a recurring basis (for monthly plans) or as a one-time charge (for Lifetime plans). All prices are displayed in USD.</p>
          <h2>5. Cancellation</h2>
          <p>You may cancel your Pro Monthly subscription at any time. Cancellation takes effect at the end of the current billing period. You will retain access until the period ends. Lifetime plans are non-cancellable as they are one-time purchases.</p>
          <h2>6. Tier Lock Policy</h2>
          <p>Once subscribed to a tier, you may not switch to a different tier while your subscription is active. You may upgrade or change your plan only after your current subscription period ends.</p>
          <h2>7. Disclaimer of Warranties</h2>
          <p>The Site and all content are provided “as is” without warranty of any kind. We make no representations or warranties regarding the accuracy, completeness, or fitness for any particular purpose of any picks or predictions provided.</p>
          <h2>8. Limitation of Liability</h2>
          <p>Soccer NBA Parlay King shall not be liable for any financial losses, damages, or other consequences resulting from your use of our picks or predictions. You acknowledge that sports outcomes are inherently unpredictable and that past performance does not guarantee future results.</p>
          <h2>9. Age Requirement</h2>
          <p>You must be at least 18 years of age to subscribe to any paid plan on this Site.</p>
          <h2>10. Contact</h2>
          <p>For questions about these Terms, contact us at: <a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a></p>
          <div class="footer"><p>&copy; 2026 Soccer NBA Parlay King. All rights reserved.</p></div>
        </div></body></html>`);
    });

    app.get('/privacy', (_req: any, res: any) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy | Soccer NBA Parlay King</title>${legalStyle}</head><body>
        <div class="header"><a href="/">⚽ Soccer NBA Parlay King</a><span>/</span><span>Privacy Policy</span></div>
        <div class="container">
          <h1>Privacy Policy</h1>
          <p><strong>Last Updated: March 8, 2026</strong></p>
          <h2>1. Information We Collect</h2>
          <p>When you subscribe, we collect your email address, payment information (processed by PayPal — we never store card numbers), and subscription tier. We also collect standard web analytics data (page views, browser type) to improve the Site.</p>
          <h2>2. How We Use Your Information</h2>
          <ul>
            <li>To process your subscription and deliver picks content</li>
            <li>To send subscription confirmation and renewal notices</li>
            <li>To provide customer support</li>
            <li>To improve our prediction engine and content</li>
          </ul>
          <h2>3. Payment Processing</h2>
          <p>All payments are processed by PayPal. We do not store, process, or transmit your credit card or bank account information. PayPal’s privacy policy governs the handling of your payment data.</p>
          <h2>4. Data Sharing — We Do Not Share Your Data</h2>
          <p><strong>We do not sell, rent, trade, lease, or share your personal information with any third party for marketing or commercial purposes — ever.</strong> Your email address, subscription details, and account data are used solely to operate your subscription and deliver picks content. The only external party that receives any of your data is PayPal, and only for the purpose of processing your payment. PayPal's own privacy policy governs how they handle that data.</p>
          <h2>5. Data Security</h2>
          <p>We use industry-standard security measures to protect your information. Your account data is stored in an encrypted database hosted on NeonDB.</p>
          <h2>6. Cookies</h2>
          <p>We use minimal cookies for session management and authentication. We do not use tracking or advertising cookies.</p>
          <h2>7. Your Rights</h2>
          <p>You may request deletion of your account and personal data at any time by contacting us at <a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a>.</p>
          <h2>8. Contact</h2>
          <p>For privacy questions: <a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a></p>
          <div class="footer"><p>&copy; 2026 Soccer NBA Parlay King. All rights reserved.</p></div>
        </div></body></html>`);
    });

    app.get('/refund', (_req: any, res: any) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refund Policy | Soccer NBA Parlay King</title>${legalStyle}</head><body>
        <div class="header"><a href="/">⚽ Soccer NBA Parlay King</a><span>/</span><span>Refund &amp; Cancellation Policy</span></div>
        <div class="container">
          <h1>Refund &amp; Cancellation Policy</h1>
          <p><strong>Last Updated: March 8, 2026</strong></p>
          <div class="disclaimer-box"><p>⚠️ <strong>ALL SALES ARE FINAL.</strong> Because our product is digital data — sports picks and analysis generated in real-time by the Gold Standard V3 Titan XII model — it is delivered immediately upon purchase and cannot be returned. By completing your purchase, you acknowledge and agree that all sales are final and non-refundable.</p></div>
          <h2>Digital Product — No Refunds</h2>
          <p>Soccer NBA Parlay King sells <strong>digital sports information and analysis</strong>. Once a subscription is activated, the digital content (daily picks, predictions, expert analysis) is delivered immediately and continuously. Because the product is intangible digital data that is consumed upon delivery, <strong>all sales are final and no refunds will be issued</strong> under any circumstances.</p>
          <p>This policy applies to all subscription tiers including:</p>
          <ul>
            <li><strong>Pro Monthly Subscription</strong> — billed monthly, all charges are final</li>
            <li><strong>Lifetime Access</strong> — one-time payment, final and non-refundable</li>
          </ul>
          <h2>Cancellation</h2>
          <p>You may cancel your Pro Monthly subscription at any time from your account dashboard. Cancellation stops future billing but does not entitle you to a refund for any charges already made. Your access will continue until the end of the current billing period.</p>
          <h2>Disputes</h2>
          <p>If you believe there has been an unauthorized charge or billing error, please contact us <strong>before</strong> filing a dispute with PayPal. We will investigate and resolve legitimate billing errors promptly.</p>
          <p>Email: <a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a></p>
          <h2>Contact</h2>
          <p><a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a></p>
          <div class="footer"><p>&copy; 2026 Soccer NBA Parlay King. All rights reserved.</p></div>
        </div></body></html>`);
    });

    app.get('/disclaimer', (_req: any, res: any) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disclaimer | Soccer NBA Parlay King</title>${legalStyle}</head><body>
        <div class="header"><a href="/">⚽ Soccer NBA Parlay King</a><span>/</span><span>Disclaimer</span></div>
        <div class="container">
          <h1>Disclaimer</h1>
          <p><strong>Last Updated: March 8, 2026</strong></p>
          <div class="disclaimer-box"><p>⚠️ IMPORTANT: All picks, predictions, and analysis on this site are for INFORMATIONAL AND ENTERTAINMENT PURPOSES ONLY. We do not guarantee any winnings, profits, or specific outcomes.</p></div>
          <h2>Sports Information Service</h2>
          <p>Soccer NBA Parlay King is a sports information and analysis service. We provide data-driven picks generated by the Titan XII V3 prediction engine. We are NOT a sportsbook, betting exchange, or gambling operator. We do not accept bets or wagers of any kind.</p>
          <h2>No Guarantee of Results</h2>
          <p>Sports outcomes are inherently unpredictable. Historical win rates and confidence percentages are based on past performance and do not guarantee future results. You may lose money if you choose to place bets based on our picks. Past performance is not indicative of future results.</p>
          <h2>Legal Compliance</h2>
          <p>Sports betting and wagering may be illegal in your jurisdiction. It is your sole responsibility to ensure that any betting activity you engage in complies with the laws of your country, state, or region. Soccer NBA Parlay King accepts no responsibility for any legal consequences arising from your betting activities.</p>
          <h2>Age Restriction</h2>
          <p>You must be at least 18 years of age (or the legal gambling age in your jurisdiction, whichever is higher) to use this service. By subscribing, you confirm that you meet this age requirement.</p>
          <h2>Responsible Gambling</h2>
          <p>If you or someone you know has a gambling problem, please seek help. Resources include:</p>
          <ul>
            <li><a href="https://www.ncpgambling.org" target="_blank">National Council on Problem Gambling</a> — 1-800-522-4700</li>
            <li><a href="https://www.gamblingtherapy.org" target="_blank">Gambling Therapy</a></li>
          </ul>
          <h2>Contact</h2>
          <p>For questions: <a href="mailto:soccernbaparlayking@gmail.com">soccernbaparlayking@gmail.com</a></p>
          <div class="footer"><p>&copy; 2026 Soccer NBA Parlay King. All rights reserved.</p></div>
        </div></body></html>`);
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
