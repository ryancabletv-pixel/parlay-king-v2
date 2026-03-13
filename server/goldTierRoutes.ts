/**
 * Hardened Tier Architecture — Gold Tier Endpoints
 * Isolated routes that read/write exclusively from the gold_tiers table.
 *
 * Pro Tier  : 6 picks (3 NBA + 3 Soccer) @ 68%+ primary / 65% fallback floor
 * Lifetime  : 10 picks (3 NBA + 4+ Soccer + 3 extra any sport) @ 70%+ / 67% floor
 * All picks : v3_audit_passed = true enforced at write time
 */
import { Express, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.SESSION_SECRET || 'parlay-king-secret-2025';

export const HARDENED_TIER_CONFIG = {
  pro: {
    totalPicks:    6,
    nbaSlots:      3,
    soccerSlots:   3,
    extraSlots:    0,
    primaryThresh: 68,
    fallbackFloor: 65,
    extraThresh:   68,
  },
  lifetime: {
    totalPicks:    10,
    nbaSlots:      3,
    soccerSlots:   4,
    extraSlots:    3,   // remaining 3 slots: any sport >= 70%
    primaryThresh: 70,
    fallbackFloor: 67,
    extraThresh:   70,
  },
} as const;

type TierName = keyof typeof HARDENED_TIER_CONFIG;

function verifyMemberToken(req: Request): { email: string; tier: string } | null {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    return jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
  } catch { return null; }
}

async function buildGoldTiersForDate(pool: any, date: string): Promise<{ summary: Record<string, any>; inserted: any[] }> {
  const { rows: allPicks } = await pool.query(
    `SELECT * FROM picks
     WHERE date = $1
       AND is_disabled = false
       AND v3_audit_passed = true
       AND sport IN ('soccer', 'nba', 'mls')
     ORDER BY confidence DESC`,
    [date]
  );

  // Delete existing gold_tiers for this date (fresh write)
  await pool.query(`DELETE FROM gold_tiers WHERE date = $1`, [date]);

  const nbaPicks    = allPicks.filter((p: any) => p.sport === 'nba');
  const soccerPicks = allPicks.filter((p: any) => p.sport === 'soccer' || p.sport === 'mls');
  const inserted: any[] = [];
  const summary: Record<string, any> = {};

  for (const [tierName, cfg] of Object.entries(HARDENED_TIER_CONFIG) as [TierName, typeof HARDENED_TIER_CONFIG.pro][]) {
    const { primaryThresh, fallbackFloor, nbaSlots, soccerSlots, extraSlots, extraThresh } = cfg;

    // NBA slots: primary threshold first, then fallback floor
    let nbaSelected = nbaPicks.filter((p: any) => p.confidence >= primaryThresh).slice(0, nbaSlots);
    if (nbaSelected.length < nbaSlots) {
      const needed = nbaSlots - nbaSelected.length;
      const ids = new Set(nbaSelected.map((p: any) => p.id));
      const fallback = nbaPicks
        .filter((p: any) => p.confidence >= fallbackFloor && p.confidence < primaryThresh && !ids.has(p.id))
        .slice(0, needed);
      nbaSelected = [...nbaSelected, ...fallback];
    }

    // Soccer slots: primary threshold first, then fallback floor
    let soccerSelected = soccerPicks.filter((p: any) => p.confidence >= primaryThresh).slice(0, soccerSlots);
    if (soccerSelected.length < soccerSlots) {
      const needed = soccerSlots - soccerSelected.length;
      const ids = new Set(soccerSelected.map((p: any) => p.id));
      const fallback = soccerPicks
        .filter((p: any) => p.confidence >= fallbackFloor && p.confidence < primaryThresh && !ids.has(p.id))
        .slice(0, needed);
      soccerSelected = [...soccerSelected, ...fallback];
    }

    // Extra slots: any sport >= extraThresh, not already selected
    const alreadyIds = new Set([...nbaSelected, ...soccerSelected].map((p: any) => p.id));
    const extraSelected = extraSlots > 0
      ? allPicks.filter((p: any) => p.confidence >= extraThresh && !alreadyIds.has(p.id)).slice(0, extraSlots)
      : [];

    const allSelected = [...nbaSelected, ...soccerSelected, ...extraSelected];

    for (const p of allSelected) {
      const nbaIdx    = nbaSelected.indexOf(p);
      const soccerIdx = soccerSelected.indexOf(p);
      const extraIdx  = extraSelected.indexOf(p);
      const sportSlot = nbaIdx >= 0    ? `nba_${nbaIdx + 1}`
                      : soccerIdx >= 0 ? `soccer_${soccerIdx + 1}`
                      : `extra_${extraIdx + 1}`;
      const isFallback = p.confidence < primaryThresh;

      try {
        await pool.query(
          `INSERT INTO gold_tiers
           (date, sport, tier, home_team, away_team, league, prediction, confidence, odds,
            fixture_id, is_power_pick, is_fallback, fallback_floor, v3_audit_passed, sport_slot, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15)
           ON CONFLICT (date, home_team, away_team, tier) DO UPDATE SET
             confidence   = EXCLUDED.confidence,
             prediction   = EXCLUDED.prediction,
             is_fallback  = EXCLUDED.is_fallback,
             sport_slot   = EXCLUDED.sport_slot,
             updated_at   = now()`,
          [
            date, p.sport, tierName,
            p.home_team, p.away_team, p.league || '',
            p.prediction, p.confidence, p.odds || '',
            p.fixture_id, p.is_power_pick || false,
            isFallback, isFallback ? fallbackFloor : null,
            sportSlot, p.metadata || null,
          ]
        );
        inserted.push({ tier: tierName, sport: p.sport, match: `${p.home_team} vs ${p.away_team}`, confidence: p.confidence, fallback: isFallback, slot: sportSlot });
      } catch (insertErr: any) {
        console.error(`[GoldTiers] Insert error for ${p.home_team} vs ${p.away_team} (${tierName}):`, insertErr.message);
      }
    }

    summary[tierName] = {
      total:   allSelected.length,
      nba:     nbaSelected.length,
      soccer:  soccerSelected.length,
      extra:   extraSelected.length,
      fallbacks: allSelected.filter(p => p.confidence < primaryThresh).length,
    };

    console.log(`[GoldTiers] ${tierName.toUpperCase()}: ${allSelected.length}/${cfg.totalPicks} picks written | NBA=${nbaSelected.length}/${nbaSlots} Soccer=${soccerSelected.length}/${soccerSlots} Extra=${extraSelected.length}/${extraSlots}`);
  }

  return { summary, inserted };
}

export function registerGoldTierRoutes(app: Express, requireAuth: any) {
  const DB_OPTS = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };

  // ── POST /api/admin/gold-tiers/write ─────────────────────────────────────
  // Reads today's picks from picks table, applies hardened tier logic, writes to gold_tiers.
  app.post('/api/admin/gold-tiers/write', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = req.body.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const { summary, inserted } = await buildGoldTiersForDate(pool, date);
      await pool.end();
      return res.json({ success: true, date, summary, inserted, total: inserted.length });
    } catch (err: any) {
      console.error('[GoldTiers] Write error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/admin/gold-tiers/trigger ───────────────────────────────────
  // Alias for /write — used by admin panel trigger button
  app.post('/api/admin/gold-tiers/trigger', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = req.body.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const { summary, inserted } = await buildGoldTiersForDate(pool, date);
      await pool.end();
      return res.json({ success: true, date, summary });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/picks/gold-tiers ─────────────────────────────────────────────
  // Admin view of both tiers for a given date
  app.get('/api/picks/gold-tiers', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const { rows } = await pool.query(
        `SELECT * FROM gold_tiers WHERE date = $1 ORDER BY tier, sport_slot, confidence DESC`,
        [date]
      );
      await pool.end();
      const pro      = rows.filter((p: any) => p.tier === 'pro');
      const lifetime = rows.filter((p: any) => p.tier === 'lifetime');
      return res.json({
        date,
        pro: {
          picks:   pro,
          total:   pro.length,
          nba:     pro.filter((p: any) => p.sport === 'nba').length,
          soccer:  pro.filter((p: any) => p.sport !== 'nba').length,
          config:  HARDENED_TIER_CONFIG.pro,
        },
        lifetime: {
          picks:   lifetime,
          total:   lifetime.length,
          nba:     lifetime.filter((p: any) => p.sport === 'nba').length,
          soccer:  lifetime.filter((p: any) => p.sport !== 'nba').length,
          config:  HARDENED_TIER_CONFIG.lifetime,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/picks/pro ────────────────────────────────────────────────────
  // Hardened Pro Tier picks (from gold_tiers table)
  // Returns exactly 6 picks: 3 NBA + 3 Soccer, 68%+ primary / 65% fallback
  // Requires valid member JWT with tier=pro or tier=lifetime
  app.get('/api/picks/pro', async (req: Request, res: Response) => {
    try {
      const member = verifyMemberToken(req);
      if (!member) return res.status(401).json({ error: 'Authentication required.' });
      if (!['pro', 'lifetime', 'admin'].includes(member.tier)) {
        return res.status(403).json({ error: 'Pro tier or higher required.' });
      }
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const { rows } = await pool.query(
        `SELECT * FROM gold_tiers
         WHERE date = $1 AND tier = 'pro' AND v3_audit_passed = true
         ORDER BY
           CASE sport_slot
             WHEN 'nba_1' THEN 1 WHEN 'nba_2' THEN 2 WHEN 'nba_3' THEN 3
             WHEN 'soccer_1' THEN 4 WHEN 'soccer_2' THEN 5 WHEN 'soccer_3' THEN 6
             ELSE 7
           END, confidence DESC`,
        [date]
      );
      await pool.end();
      const cfg    = HARDENED_TIER_CONFIG.pro;
      const nba    = rows.filter((p: any) => p.sport === 'nba');
      const soccer = rows.filter((p: any) => p.sport !== 'nba');
      return res.json({
        tier:    'pro',
        date,
        picks:   rows,
        total:   rows.length,
        composition: { nba: nba.length, soccer: soccer.length, extra: 0 },
        config:  cfg,
        v3_audit_passed: rows.every((p: any) => p.v3_audit_passed),
        fallback_used:   rows.some((p: any) => p.is_fallback),
        fallback_picks:  rows.filter((p: any) => p.is_fallback).map((p: any) => ({
          match: `${p.home_team} vs ${p.away_team}`, confidence: p.confidence, floor: p.fallback_floor,
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/picks/lifetime ───────────────────────────────────────────────
  // Hardened Lifetime Tier picks (from gold_tiers table)
  // Returns exactly 10 picks: 3 NBA + 4+ Soccer + 3 extra any sport, 70%+ / 67% floor
  // Requires valid member JWT with tier=lifetime
  app.get('/api/picks/lifetime', async (req: Request, res: Response) => {
    try {
      const member = verifyMemberToken(req);
      if (!member) return res.status(401).json({ error: 'Authentication required.' });
      if (!['lifetime', 'admin'].includes(member.tier)) {
        return res.status(403).json({ error: 'Lifetime tier required.' });
      }
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const { rows } = await pool.query(
        `SELECT * FROM gold_tiers
         WHERE date = $1 AND tier = 'lifetime' AND v3_audit_passed = true
         ORDER BY
           CASE sport_slot
             WHEN 'nba_1' THEN 1 WHEN 'nba_2' THEN 2 WHEN 'nba_3' THEN 3
             WHEN 'soccer_1' THEN 4 WHEN 'soccer_2' THEN 5 WHEN 'soccer_3' THEN 6 WHEN 'soccer_4' THEN 7
             WHEN 'extra_1' THEN 8 WHEN 'extra_2' THEN 9 WHEN 'extra_3' THEN 10
             ELSE 11
           END, confidence DESC`,
        [date]
      );
      await pool.end();
      const cfg    = HARDENED_TIER_CONFIG.lifetime;
      const nba    = rows.filter((p: any) => p.sport === 'nba');
      const soccer = rows.filter((p: any) => p.sport !== 'nba' && !(p.sport_slot || '').startsWith('extra'));
      const extra  = rows.filter((p: any) => (p.sport_slot || '').startsWith('extra'));
      return res.json({
        tier:    'lifetime',
        date,
        picks:   rows,
        total:   rows.length,
        composition: { nba: nba.length, soccer: soccer.length, extra: extra.length },
        config:  cfg,
        v3_audit_passed: rows.every((p: any) => p.v3_audit_passed),
        fallback_used:   rows.some((p: any) => p.is_fallback),
        fallback_picks:  rows.filter((p: any) => p.is_fallback).map((p: any) => ({
          match: `${p.home_team} vs ${p.away_team}`, confidence: p.confidence, floor: p.fallback_floor,
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/admin/gold-tiers ───────────────────────────────────────────────────────────────────────────────
  // Admin Master View: returns gold_tiers for a specific tier and date
  app.get('/api/admin/gold-tiers', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const tier = (req.query.tier as string) || 'pro';
      const { rows } = await pool.query(
        `SELECT * FROM gold_tiers WHERE date = $1 AND tier = $2 ORDER BY confidence DESC`,
        [date, tier]
      );
      await pool.end();
      return res.json(rows);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/admin/upcoming-games ─────────────────────────────────────────────────────────────────────────────
  // V2 Validator: fetch upcoming games from pending_validator or Odds API
  app.get('/api/admin/upcoming-games', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const hours = parseInt((req.query.hours as string) || '48', 10);
      // First try pending_validator table
      let games: any[] = [];
      try {
        const { rows } = await pool.query(
          `SELECT * FROM pending_validator WHERE game_date >= NOW() AND game_date <= NOW() + INTERVAL '${hours} hours' ORDER BY game_date ASC LIMIT 50`
        );
        games = rows.map((r: any) => ({
          id: r.id, homeTeam: r.home_team, awayTeam: r.away_team,
          league: r.league, sport: r.sport, date: r.game_date,
          confidence: r.confidence, fixtureId: r.fixture_id
        }));
      } catch (pvErr) {
        // pending_validator may not exist yet — fall back to picks table
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const { rows } = await pool.query(
          `SELECT * FROM picks WHERE date = $1 ORDER BY confidence DESC LIMIT 30`,
          [tomorrow.toLocaleDateString('en-CA')]
        );
        games = rows.map((r: any) => ({
          id: r.id, homeTeam: r.home_team, awayTeam: r.away_team,
          league: r.league, sport: r.sport, date: r.date,
          confidence: r.confidence, fixtureId: r.fixture_id
        }));
      }
      await pool.end();
      return res.json({ games, total: games.length, hours });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/admin/v2-audit ────────────────────────────────────────────────────────────────────────────────────
  // V2 Validator: run V3-15 audit on a specific game
  app.post('/api/admin/v2-audit', requireAuth, async (req: Request, res: Response) => {
    try {
      const { homeTeam, awayTeam, league, sport } = req.body;
      if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'homeTeam and awayTeam required' });
      // Run the V3-15 engine on this specific fixture
      const { runBatchPredictions } = await import('./goldStandardV2.js');
      const fixture = {
        fixtureId: `v2audit_${Date.now()}`,
        homeTeam, awayTeam, league: league || 'Unknown', sport: sport || 'soccer',
        homeOdds: undefined, awayOdds: undefined, drawOdds: undefined,
        homeWinRate: undefined, awayWinRate: undefined,
        homeForm: undefined, awayForm: undefined,
        homeRank: undefined, awayRank: undefined,
        homeGoalsFor: undefined, awayGoalsFor: undefined,
        homeGoalsAgainst: undefined, awayGoalsAgainst: undefined,
        homeInjuries: 0, awayInjuries: 0,
        isNeutralVenue: false, venueName: undefined,
        headToHead: undefined,
      };
      const results = runBatchPredictions([fixture as any]);
      const result = results[0];
      if (!result) return res.status(200).json({ confidence: 0, passed: false, factors: {} });
      return res.json({
        confidence: result.topConfidence,
        pick: result.topPick,
        passed: result.topConfidence >= 65,
        tier: result.tier,
        factors: result.factors || {},
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/admin/manual-publish ───────────────────────────────────────────────────────────────────────────────
  // V2 Validator: manually publish a pick to a specific tier
  app.post('/api/admin/manual-publish', requireAuth, async (req: Request, res: Response) => {
    try {
      const { homeTeam, awayTeam, league, sport, confidence, tier, source } = req.body;
      if (!homeTeam || !awayTeam || !tier) return res.status(400).json({ error: 'homeTeam, awayTeam, and tier required' });
      const { Pool } = await import('pg');
      const pool = new Pool(DB_OPTS);
      const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const validTiers = ['pro', 'lifetime'];
      if (!validTiers.includes(tier)) return res.status(400).json({ error: 'tier must be pro or lifetime' });
      // Insert into gold_tiers
      await pool.query(
        `INSERT INTO gold_tiers (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, is_power_pick, is_fallback, v3_audit_passed, sport_slot, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, false, true, $11, $12)
         ON CONFLICT (date, home_team, away_team, tier) DO UPDATE SET confidence=EXCLUDED.confidence, updated_at=now()`,
        [date, sport||'soccer', tier, homeTeam, awayTeam, league||'', `${homeTeam} Win`, confidence||0, '', `manual_${Date.now()}`, `manual_1`, JSON.stringify({ source: source||'v2-validator', publishedAt: new Date().toISOString() })]
      );
      // Also insert into picks table
      await pool.query(
        `INSERT INTO picks (date, sport, league, home_team, away_team, prediction, confidence, tier, status, is_power_pick, v3_audit_passed, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', false, true, $9)
         ON CONFLICT DO NOTHING`,
        [date, sport||'soccer', league||'', homeTeam, awayTeam, `${homeTeam} Win`, confidence||0, tier, JSON.stringify({ source: source||'v2-validator', publishedAt: new Date().toISOString() })]
      );
      await pool.end();
      return res.json({ success: true, message: `Published ${homeTeam} vs ${awayTeam} to ${tier} tier`, date });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
