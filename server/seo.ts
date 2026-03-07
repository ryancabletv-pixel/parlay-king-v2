/**
 * SEO Module — Google Ping + Sitemap Generator
 *
 * Automatically pings Google (and Bing) every time picks are updated so
 * all pages stay indexed and fresh content is discovered immediately.
 *
 * Ping targets:
 *  1. Google Search Console sitemap ping
 *     https://www.google.com/ping?sitemap=https://soccernbaparlayking.vip/sitemap.xml
 *  2. Bing / IndexNow ping
 *     https://www.bing.com/ping?sitemap=https://soccernbaparlayking.vip/sitemap.xml
 *  3. IndexNow (Bing/Yandex) per-URL submission
 *     https://api.indexnow.org/indexnow
 *
 * Sitemap covers all live pages:
 *  / (home)
 *  /picks
 *  /soccer-picks
 *  /nba-picks
 *  /parlays
 *  /results
 *  /vip
 *  /pro
 *  /admin
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const DOMAIN = 'https://soccernbaparlayking.vip';

// All live pages that should be indexed
const SITE_PAGES = [
  { url: '/',              priority: '1.0', changefreq: 'daily'   },
  { url: '/picks',         priority: '0.9', changefreq: 'daily'   },
  { url: '/soccer-picks',  priority: '0.9', changefreq: 'daily'   },
  { url: '/nba-picks',     priority: '0.9', changefreq: 'daily'   },
  { url: '/parlays',       priority: '0.8', changefreq: 'daily'   },
  { url: '/results',       priority: '0.8', changefreq: 'daily'   },
  { url: '/vip',           priority: '0.7', changefreq: 'weekly'  },
  { url: '/pro',           priority: '0.7', changefreq: 'weekly'  },
  { url: '/admin',         priority: '0.3', changefreq: 'monthly' },
];

// ─── Sitemap XML Generator ────────────────────────────────────────────────────
export function generateSitemapXml(): string {
  const today = new Date().toISOString().split('T')[0];
  const urls = SITE_PAGES.map(p => `
  <url>
    <loc>${DOMAIN}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// ─── HTTP GET helper ──────────────────────────────────────────────────────────
function httpGet(url: string): Promise<number> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = (mod as typeof https).get(url, (res) => {
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
  });
}

// ─── HTTP POST helper ─────────────────────────────────────────────────────────
function httpPost(url: string, body: string, contentType = 'application/json'): Promise<number> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ─── Google + Bing Sitemap Ping ───────────────────────────────────────────────
export async function pingSitemapToSearchEngines(): Promise<void> {
  const sitemapUrl = encodeURIComponent(`${DOMAIN}/sitemap.xml`);

  const pings = [
    { name: 'Google', url: `https://www.google.com/ping?sitemap=${sitemapUrl}` },
    { name: 'Bing',   url: `https://www.bing.com/ping?sitemap=${sitemapUrl}`   },
  ];

  for (const ping of pings) {
    try {
      const status = await httpGet(ping.url);
      console.log(`[SEO] ${ping.name} sitemap ping → HTTP ${status}`);
    } catch (err) {
      console.warn(`[SEO] ${ping.name} ping failed:`, err);
    }
  }
}

// ─── IndexNow Per-URL Submission ──────────────────────────────────────────────
// Submits all live page URLs to IndexNow (Bing/Yandex) for immediate crawling.
export async function submitIndexNow(): Promise<void> {
  const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'parlayking-indexnow-key';
  const urlList = SITE_PAGES.map(p => `${DOMAIN}${p.url}`);

  const body = JSON.stringify({
    host: 'soccernbaparlayking.vip',
    key: INDEXNOW_KEY,
    keyLocation: `${DOMAIN}/${INDEXNOW_KEY}.txt`,
    urlList,
  });

  try {
    const status = await httpPost('https://api.indexnow.org/indexnow', body);
    console.log(`[SEO] IndexNow submission → HTTP ${status} (${urlList.length} URLs)`);
  } catch (err) {
    console.warn('[SEO] IndexNow submission failed:', err);
  }
}

// ─── Full SEO Ping (called after every pick update) ───────────────────────────
// This is the main function wired into the scheduler after daily generation.
export async function pingGoogleAfterUpdate(reason = 'daily-picks-update'): Promise<void> {
  console.log(`[SEO] Running full Google/Bing ping — reason: ${reason}`);
  try {
    await Promise.allSettled([
      pingSitemapToSearchEngines(),
      submitIndexNow(),
    ]);
    console.log('[SEO] All search engine pings complete');
  } catch (err) {
    console.warn('[SEO] Ping error:', err);
  }
}

// ─── Register SEO Routes ──────────────────────────────────────────────────────
// Call this from registerRoutes() to serve /sitemap.xml and /robots.txt
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSeoRoutes(app: any): void {
  // Serve dynamic sitemap.xml
  app.get('/sitemap.xml', (_req, res) => {
    const xml = generateSitemapXml();
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(xml);
    console.log('[SEO] Sitemap served');
  });

  // Serve robots.txt
  app.get('/robots.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${DOMAIN}/sitemap.xml\n`
    );
  });

  // IndexNow key file
  const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'parlayking-indexnow-key';
  app.get(`/${INDEXNOW_KEY}.txt`, (_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(INDEXNOW_KEY);
  });

  console.log('[SEO] Routes registered: /sitemap.xml, /robots.txt');
}
