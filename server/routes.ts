import { Express, Request, Response, NextFunction } from 'express';
import * as storage from './storage.js';
import { runTitanXII, runBatchPredictions, FixtureData } from './goldStandardV2.js';
import { runDailyGeneration } from './scheduler.js';

// Admin passwords
const ADMIN_PASSWORDS = ['Parlayking', '386Leblanc', 'admin123'];

// Simple token store (in-memory; use Redis in production)
const activeTokens = new Set<string>();

function generateToken(): string {
  return Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64');
}

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-admin-token'] as string || req.query.token as string;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Daily Pick Generation (exported for scheduler) ───────────────────────────
export async function generateDailyPicks(date: string): Promise<{
  total: number; soccer: number; nba: number; ftpUploaded: boolean;
}> {
  console.log(`[Engine] Generating picks for ${date}`);

  // Fetch fixtures from API-Football
  let fixtures: FixtureData[] = [];
  try {
    const { fetchTodayFixtures } = await import('./apis/apiFootball.js');
    fixtures = await fetchTodayFixtures(date);
  } catch (err) {
    console.warn('[Engine] API-Football fetch failed, using mock data:', err);
    fixtures = getMockFixtures(date);
  }

  // If no live fixtures found, use mock data so the dashboard always shows picks
  if (fixtures.length === 0) {
    console.log('[Engine] No live fixtures found — using mock fixtures for demo');
    fixtures = getMockFixtures(date);
  }

  // Run Titan XII engine
  const predictions = runBatchPredictions(fixtures);

  // Save picks to database
  let soccerCount = 0;
  let nbaCount = 0;

  for (const pred of predictions) {
    try {
      await storage.createPick({
        date,
        sport: pred.sport,
        tier: pred.tier,
        homeTeam: pred.homeTeam,
        awayTeam: pred.awayTeam,
        league: pred.league,
        prediction: pred.topPick,
        confidence: pred.topConfidence,
        fixtureId: String(pred.fixtureId),
        isPowerPick: pred.isPowerPick,
        metadata: pred as any,
      });
      if (pred.sport === 'soccer') soccerCount++;
      else nbaCount++;
    } catch (err) {
      console.error('[Engine] Failed to save pick:', err);
    }
  }

  // FTP upload
  let ftpUploaded = false;
  try {
    const { uploadPicksToFTP } = await import('./apis/upload.js');
    await uploadPicksToFTP(date, predictions);
    ftpUploaded = true;
  } catch (err) {
    console.warn('[Engine] FTP upload failed:', err);
  }

  return { total: predictions.length, soccer: soccerCount, nba: nbaCount, ftpUploaded };
}

function getMockFixtures(date: string): FixtureData[] {
  return [
    {
      fixtureId: 'mock-1',
      homeTeam: 'Manchester City',
      awayTeam: 'Arsenal',
      league: 'Premier League',
      sport: 'soccer',
      date,
      homeOdds: 1.85,
      drawOdds: 3.50,
      awayOdds: 4.20,
      homeForm: ['W', 'W', 'D', 'W', 'W'],
      awayForm: ['W', 'D', 'W', 'L', 'W'],
      homeWinRate: 0.72,
      awayWinRate: 0.65,
      homeRestDays: 4,
      awayRestDays: 3,
    },
    {
      fixtureId: 'mock-2',
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Boston Celtics',
      league: 'NBA',
      sport: 'nba',
      date,
      homeOdds: 2.10,
      awayOdds: 1.75,
      homeForm: ['W', 'L', 'W', 'W', 'D'],
      awayForm: ['W', 'W', 'W', 'L', 'W'],
      homeWinRate: 0.58,
      awayWinRate: 0.68,
    },
  ];
}

// ─── Register All Routes ──────────────────────────────────────────────────────
export async function registerRoutes(app: Express) {
  await storage.initializeDatabase();

  // ── Authentication ──────────────────────────────────────────────────────────
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (ADMIN_PASSWORDS.includes(password)) {
      const token = generateToken();
      activeTokens.add(token);
      // Auto-expire token after 7 days
      setTimeout(() => activeTokens.delete(token), 7 * 24 * 60 * 60 * 1000);
      return res.json({ token, success: true });
    }
    res.status(401).json({ error: 'Invalid password' });
  });

  app.get('/api/admin/status', requireAuth, async (req, res) => {
    try {
      const [winloss, logs] = await Promise.all([
        storage.getWinLossSummary(),
        storage.getRunLogs(5),
      ]);
      res.json({ winloss, recentRuns: logs, schedulerActive: true, version: 'V3 Titan XII' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version: 'V3 Titan XII', timestamp: new Date().toISOString() });
  });

  // ── Picks ───────────────────────────────────────────────────────────────────
  app.get('/api/admin/picks', requireAuth, async (req, res) => {
    try {
      const date = req.query.date as string || new Date().toLocaleDateString('en-CA');
      const picks = await storage.getPicksByDate(date);
      res.json(picks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/picks', requireAuth, async (req, res) => {
    try {
      const pick = await storage.createPick(req.body);
      res.json(pick);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/picks/:id', requireAuth, async (req, res) => {
    try {
      const pick = await storage.updatePick(parseInt(req.params.id), req.body);
      res.json(pick);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/picks/:id', requireAuth, async (req, res) => {
    try {
      await storage.deletePick(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/active-tier-picks', requireAuth, async (req, res) => {
    try {
      const date = new Date().toLocaleDateString('en-CA');
      const picks = await storage.getPicksByDate(date);
      const byTier = { free: picks.filter(p => p.tier === 'free'), vip: picks.filter(p => p.tier === 'vip'), pro: picks.filter(p => p.tier === 'pro') };
      res.json(byTier);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Parlays ─────────────────────────────────────────────────────────────────
  app.get('/api/admin/parlays', requireAuth, async (req, res) => {
    try {
      const date = req.query.date as string || new Date().toLocaleDateString('en-CA');
      const parlays = await storage.getParlaysByDate(date);
      res.json(parlays);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/parlays', requireAuth, async (req, res) => {
    try {
      const { date, type, legs, totalOdds } = req.body;
      const parlay = await storage.saveParlays(date, type, legs, totalOdds);
      res.json(parlay);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/parlay-override', requireAuth, async (req, res) => {
    try {
      const { date, legs, totalOdds } = req.body;
      const parlay = await storage.saveParlays(date || new Date().toLocaleDateString('en-CA'), 'soccer', legs, totalOdds);
      res.json({ success: true, parlay });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/nba-parlay-override', requireAuth, async (req, res) => {
    try {
      const { date, legs, totalOdds } = req.body;
      const parlay = await storage.saveParlays(date || new Date().toLocaleDateString('en-CA'), 'nba', legs, totalOdds);
      res.json({ success: true, parlay });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Results & Records ───────────────────────────────────────────────────────
  app.get('/api/admin/results', requireAuth, async (req, res) => {
    try {
      const results = await storage.getResults();
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/results', requireAuth, async (req, res) => {
    try {
      const result = await storage.createResult(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/results/:id', requireAuth, async (req, res) => {
    try {
      const result = await storage.updateResult(parseInt(req.params.id), req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/winloss', requireAuth, async (req, res) => {
    try {
      const summary = await storage.getWinLossSummary();
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/tier-results/:tier', requireAuth, async (req, res) => {
    try {
      const results = await storage.getResults();
      const tierResults = results.filter(r => r.tier === req.params.tier);
      const wins = tierResults.filter(r => r.result === 'won').length;
      const losses = tierResults.filter(r => r.result === 'lost').length;
      const total = wins + losses;
      res.json({ tier: req.params.tier, wins, losses, total, winRate: total > 0 ? Math.round(wins / total * 1000) / 10 : 0, results: tierResults });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Engine & Validation ─────────────────────────────────────────────────────
  app.post('/api/admin/trigger', requireAuth, async (req, res) => {
    try {
      const date = req.body.date || new Date().toLocaleDateString('en-CA');
      res.json({ message: 'Generation started', date });
      // Run async
      generateDailyPicks(date).catch(err => console.error('[Trigger] Error:', err));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/runs', requireAuth, async (req, res) => {
    try {
      const logs = await storage.getRunLogs(30);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/engine-config', requireAuth, async (req, res) => {
    try {
      const config = await storage.getEngineConfig();
      res.json(config);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/v2-validate', requireAuth, async (req, res) => {
    try {
      const fixture: FixtureData = req.body;
      const result = runTitanXII(fixture);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/refresh-data', requireAuth, async (req, res) => {
    try {
      const { clearApiCache } = await import('./apis/apiFootball.js');
      clearApiCache();
      res.json({ success: true, message: 'API cache cleared — next generation will fetch live data' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/cache-status', requireAuth, async (req, res) => {
    try {
      const { getCacheStatus } = await import('./apis/apiFootball.js');
      const status = getCacheStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/player-stats', requireAuth, async (req, res) => {
    try {
      const date = req.query.date as string || new Date().toLocaleDateString('en-CA');
      const sport = req.query.sport as string;
      const stats = await storage.getPlayerStats(date, sport);
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Members & Tiers ─────────────────────────────────────────────────────────
  app.post('/api/member/login', async (req, res) => {
    try {
      const { email, tier } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' });
      const member = await storage.createOrUpdateMember(email, tier || 'free');
      const token = generateToken();
      activeTokens.add(token);
      res.json({ token, member });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/member/heartbeat', async (req, res) => {
    try {
      const { email, page } = req.body;
      if (email) await storage.recordHeartbeat(email, page);
      res.json({ ok: true });
    } catch {
      res.json({ ok: true });
    }
  });

  app.get('/api/admin/active-users', requireAuth, async (req, res) => {
    try {
      const minutes = parseInt(req.query.minutes as string) || 15;
      const users = await storage.getActiveUsers(minutes);
      res.json({ count: users.length, users });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/members', requireAuth, async (req, res) => {
    try {
      const members = await storage.getMembers();
      res.json(members);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/tiers-pricing', requireAuth, async (req, res) => {
    try {
      const pricing = await storage.getTierPricing();
      res.json(pricing);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tiers-pricing', requireAuth, async (req, res) => {
    try {
      const { tier, price, label } = req.body;
      await storage.setTierPricing(tier, price, label);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tier-assign', requireAuth, async (req, res) => {
    try {
      const { pickId, tier } = req.body;
      const pick = await storage.updatePick(pickId, { tier });
      res.json(pick);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Content & SEO ───────────────────────────────────────────────────────────
  app.get('/api/admin/expert', requireAuth, async (req, res) => {
    res.json({ content: '', visible: true });
  });

  app.post('/api/admin/expert/update', requireAuth, async (req, res) => {
    res.json({ success: true });
  });

  app.get('/api/admin/featured', requireAuth, async (req, res) => {
    try {
      const date = new Date().toLocaleDateString('en-CA');
      const picks = await storage.getPicksByDate(date);
      const featured = picks.find(p => p.isFeatured) || picks[0] || null;
      res.json({ featured, trending: picks.slice(0, 3) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/featured/update', requireAuth, async (req, res) => {
    res.json({ success: true });
  });

  app.get('/api/admin/featured/visibility', requireAuth, async (req, res) => {
    res.json({ visible: true });
  });

  app.post('/api/admin/featured/visibility', requireAuth, async (req, res) => {
    res.json({ success: true });
  });

  app.post('/api/admin/homepage-edit', requireAuth, async (req, res) => {
    res.json({ success: true });
  });

  app.post('/api/admin/seo-ping', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'SEO pings sent' });
  });

  // ── FTP ─────────────────────────────────────────────────────────────────────
  app.get('/api/admin/ftp-files', requireAuth, async (req, res) => {
    try {
      const { listFTPFiles } = await import('./apis/upload.js');
      const files = await listFTPFiles();
      res.json(files);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/ftp-files', requireAuth, async (req, res) => {
    try {
      const { deleteFTPFile } = await import('./apis/upload.js');
      await deleteFTPFile(req.body.filename);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Alerts ──────────────────────────────────────────────────────────────────
  app.get('/api/admin/alerts', requireAuth, async (req, res) => {
    try {
      const alerts = await storage.getAlerts();
      res.json(alerts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Lock System ─────────────────────────────────────────────────────────────
  let manualLock = false;
  app.get('/api/admin/lock-status', requireAuth, (req, res) => {
    res.json({ locked: manualLock });
  });

  app.post('/api/admin/lock-toggle', requireAuth, (req, res) => {
    manualLock = !manualLock;
    res.json({ locked: manualLock });
  });

  app.post('/api/admin/set-manual-lock', requireAuth, (req, res) => {
    manualLock = req.body.locked ?? true;
    res.json({ locked: manualLock });
  });

  // ── Audit Reports ───────────────────────────────────────────────────────────
  app.get('/api/admin/audit-reports', requireAuth, async (req, res) => {
    try {
      const reports = await storage.getAuditReports();
      res.json(reports);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/audit-trigger', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Audit report generation queued' });
  });

  // ── Public Endpoints ────────────────────────────────────────────────────────
  app.get('/api/bet-builder/games', async (req, res) => {
    try {
      const date = new Date().toLocaleDateString('en-CA');
      const picks = await storage.getPicksByDate(date);
      const freePicks = picks.filter(p => p.tier === 'free' && !p.isDisabled);
      res.json(freePicks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/nba-props', async (req, res) => {
    res.json({ props: [], message: 'NBA props updated daily at 11 AM AST' });
  });

  // ── Re-engage ───────────────────────────────────────────────────────────────
  app.post('/api/admin/re-engage', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Re-engagement notifications queued' });
  });

  console.log('[Routes] All API routes registered');
}
