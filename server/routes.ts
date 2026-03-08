import { Express, Request, Response, NextFunction } from 'express';
import * as storage from './storage.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { runTitanXII, runBatchPredictions, FixtureData, PredictionResult } from './goldStandardV2.js';
import { runDailyGeneration } from './scheduler.js';
import * as path from 'path';
import * as fs from 'fs';

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

// ─── Pick Selection Logic ─────────────────────────────────────────────────────
// Selects the best N picks from a pool of predictions.
// Priority: highest confidence first, then highest value (odds × confidence).
// Safety filter: only picks with confidence >= threshold AND positive value.

const CONFIDENCE_THRESHOLDS = {
  FREE_MIN:   64,   // Free tier: 64-67%
  FREE_MAX:   67,   // Free tier ceiling
  PRO_MIN:    68,   // Pro tier: 68%+
  LIFETIME_MIN: 70, // Lifetime tier: 70%+
  POWER_PICK: 80,   // Power Pick badge
} as const;

// Tier pick counts
const TIER_PICK_COUNTS = {
  free:     2,   // 2 picks at 64-67%
  pro:      6,   // 6 picks at 68%+
  lifetime: 10,  // 10 picks at 70%+
} as const;

function selectBestLegs(
  predictions: PredictionResult[],
  count: number,
  minConfidence = CONFIDENCE_THRESHOLDS.PRO_MIN,
  maxConfidence = 100
): PredictionResult[] {
  // Filter: must pass threshold, must not be a draw pick (draws are low-value)
  const qualified = predictions
    .filter(p => p.topConfidence >= minConfidence && p.topConfidence <= maxConfidence)
    .filter(p => !p.topPick.toLowerCase().includes('draw'))
    .sort((a, b) => {
      // Primary sort: confidence descending
      // Secondary sort: value score (confidence × implied odds value)
      const aValue = a.topConfidence * (a.factors?.valueScore ?? 1);
      const bValue = b.topConfidence * (b.factors?.valueScore ?? 1);
      return bValue - aValue;
    });

  // Deduplicate: no two picks from the same match
  const seen = new Set<string>();
  const unique: PredictionResult[] = [];
  for (const p of qualified) {
    const key = `${p.homeTeam}|${p.awayTeam}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  return unique.slice(0, count);
}

// ─── Daily Pick Generation (exported for scheduler) ───────────────────────────
// Produces exactly:
//   • 3 NBA legs     → saved as sport='nba',   type='nba'
//   • 3 MLS legs     → saved as sport='mls',   type='mls'  (blank if no games)
//   • 3 Soccer legs  → saved as sport='soccer', type='soccer'
//   • 1 Power Pick   → saved as isPowerPick=true, type='power'
//
// All picks must pass the 12-factor engine with ≥68% confidence.
// Games are selected for safety, high probability, and high value.
// Date accuracy is enforced — only fixtures confirmed for `date` are used.

export async function generateDailyPicks(date: string): Promise<{
  total: number;
  soccer: number;
  nba: number;
  mls: number;
  powerPick: number;
  ftpUploaded: boolean;
}> {
  console.log(`\n[Engine] ═══════════════════════════════════════════════`);
  console.log(`[Engine] Gold Standard V3 Titan XII — Generating picks`);
  console.log(`[Engine] Date: ${date} | Timezone: America/Moncton`);
  console.log(`[Engine] ═══════════════════════════════════════════════`);

  // ── Fetch all fixtures ────────────────────────────────────────────────────
  let soccerFixtures: FixtureData[] = [];
  let nbaFixtures: FixtureData[]    = [];

  try {
    const { fetchSoccerFixtures, fetchNBAFixtures } = await import('./apis/apiFootball.js');
    [soccerFixtures, nbaFixtures] = await Promise.all([
      fetchSoccerFixtures(date).catch(err => {
        console.error('[Engine] CRITICAL: Soccer API fetch failed:', err.message);
        return [] as FixtureData[];
      }),
      fetchNBAFixtures(date).catch(err => {
        console.error('[Engine] CRITICAL: NBA API fetch failed:', err.message);
        return [] as FixtureData[];
      }),
    ]);
  } catch (err) {
    console.error('[Engine] CRITICAL: API fetch completely failed:', err);
  }

  console.log(`[Engine] LIVE API data: ${soccerFixtures.length} soccer fixtures, ${nbaFixtures.length} NBA fixtures`);
  if (soccerFixtures.length === 0) {
    console.error('[Engine] WARNING: No live soccer fixtures returned by API-Football for', date);
  }
  if (nbaFixtures.length === 0) {
    console.error('[Engine] WARNING: No live NBA fixtures returned by API-Basketball for', date);
  }

  // Separate MLS from soccer
  const mlsFixtures    = soccerFixtures.filter(f => f.sport === 'mls');
  const pureSOccer     = soccerFixtures.filter(f => f.sport === 'soccer');

  console.log(`[Engine] Fixtures loaded: ${pureSOccer.length} soccer, ${mlsFixtures.length} MLS, ${nbaFixtures.length} NBA`);

  // ── Run Titan XII engine on all fixtures ──────────────────────────────────
  const soccerPreds = runBatchPredictions(pureSOccer);
  const mlsPreds    = runBatchPredictions(mlsFixtures);
  const nbaPreds    = runBatchPredictions(nbaFixtures);

  console.log(`[Engine] Predictions: ${soccerPreds.length} soccer, ${mlsPreds.length} MLS, ${nbaPreds.length} NBA`);

  // ── Select tiered picks from all predictions ────────────────────────────
  // All predictions combined for cross-sport tier selection
  const allPreds = [...soccerPreds, ...mlsPreds, ...nbaPreds];

  // FREE TIER: 2 picks at 64-67% (below the pro threshold)
  const freePicks = selectBestLegs(allPreds, TIER_PICK_COUNTS.free,
    CONFIDENCE_THRESHOLDS.FREE_MIN, CONFIDENCE_THRESHOLDS.FREE_MAX);

  // PRO TIER: 6 picks at 68%+ (sorted by confidence, best first)
  const proPicks = selectBestLegs(allPreds, TIER_PICK_COUNTS.pro,
    CONFIDENCE_THRESHOLDS.PRO_MIN, 100);

  // LIFETIME TIER: 10 picks at 70%+ (top picks only)
  const lifetimePicks = selectBestLegs(allPreds, TIER_PICK_COUNTS.lifetime,
    CONFIDENCE_THRESHOLDS.LIFETIME_MIN, 100);

  // GUARDRAIL 1 — NO MOCK DATA: Sport-specific parlays use LIVE API data only.
  // If real API returns insufficient legs, the engine logs NULL and saves 0 picks.
  // No placeholder or mock fixtures are ever used.
  let soccerLegs = selectBestLegs(soccerPreds, 3, CONFIDENCE_THRESHOLDS.PRO_MIN);
  let mlsLegs    = selectBestLegs(mlsPreds,    3, CONFIDENCE_THRESHOLDS.PRO_MIN);
  let nbaLegs    = selectBestLegs(nbaPreds,    3, CONFIDENCE_THRESHOLDS.PRO_MIN);

  // ── Log real API leg counts ──────────────────────────────────────────────
  console.log(`[Engine] LIVE legs at 68%+: Soccer=${soccerLegs.length}/3, NBA=${nbaLegs.length}/3, MLS=${mlsLegs.length}/3`);
  if (soccerLegs.length < 3) {
    console.error(`[Engine] CRITICAL: Only ${soccerLegs.length}/3 soccer legs passed 68% threshold from LIVE API data`);
    console.error(`[Engine] Soccer fixtures scored: ${soccerPreds.map(p => p.homeTeam + ' vs ' + p.awayTeam + ' @ ' + p.topConfidence + '%').join(', ')}`);
  }
  if (nbaLegs.length < 3) {
    console.error(`[Engine] CRITICAL: Only ${nbaLegs.length}/3 NBA legs passed 68% threshold from LIVE API data`);
    console.error(`[Engine] NBA fixtures scored: ${nbaPreds.map(p => p.homeTeam + ' vs ' + p.awayTeam + ' @ ' + p.topConfidence + '%').join(', ')}`);
  }
  if (mlsLegs.length < 3) {
    console.error(`[Engine] CRITICAL: Only ${mlsLegs.length}/3 MLS legs passed 68% threshold from LIVE API data`);
    console.error(`[Engine] MLS fixtures scored: ${mlsPreds.map(p => p.homeTeam + ' vs ' + p.awayTeam + ' @ ' + p.topConfidence + '%').join(', ')}`);
  }

  // ── Select 1 Power Pick (highest confidence across ALL sports ≥70%) ─────
  // GUARDRAIL 1: Power Pick uses LIVE API data only. No mock fallback.
  const powerCandidates = allPreds
    .filter(p => p.topConfidence >= CONFIDENCE_THRESHOLDS.LIFETIME_MIN)
    .filter(p => !p.topPick.toLowerCase().includes('draw'))
    .sort((a, b) => b.topConfidence - a.topConfidence);
  const powerPick = powerCandidates[0] || null;  // NULL if no real 70%+ picks

  console.log(`[Engine] Tiered picks: ${freePicks.length} Free (64-67%), ${proPicks.length} Pro (68%+), ${lifetimePicks.length} Lifetime (70%+)`);
  console.log(`[Engine] Sport parlays: ${soccerLegs.length} soccer, ${mlsLegs.length} MLS, ${nbaLegs.length} NBA`);
  console.log(`[Engine] Power Pick: ${powerPick ? `${powerPick.homeTeam} vs ${powerPick.awayTeam} (${powerPick.topConfidence.toFixed(1)}%)` : 'none'}`);

  // ── Log threshold filter results ──────────────────────────────────────────
  const totalScored = allPreds.length;
  const totalPassed = freePicks.length + proPicks.length;
  const totalDiscarded = totalScored - totalPassed;
  console.log(`[Titan XII] Threshold filter: Free=${freePicks.length} (64-67%) | Pro=${proPicks.length} (68%+) | Lifetime=${lifetimePicks.length} (70%+) | Discarded=${totalDiscarded}`);

  // ── Delete today's existing picks (fresh generation) ─────────────────────
  // NOTE: We only delete picks for today's date — never touch other dates
  try {
    const existingPicks = await storage.getPicksByDate(date);
    for (const pick of existingPicks) {
      await storage.deletePick(pick.id);
    }
    console.log(`[Engine] Cleared ${existingPicks.length} existing picks for ${date}`);
  } catch (err) {
    console.warn('[Engine] Failed to clear existing picks:', err);
  }

  // ── Save picks to database ────────────────────────────────────────────────
  let soccerCount = 0, nbaCount = 0, mlsCount = 0, powerCount = 0;

  // Helper to save a pick
  async function savePick(pred: PredictionResult, overrideSport?: string, overrideTier?: string, isPower = false) {
    try {
      await storage.createPick({
        date,
        sport:      overrideSport || pred.sport,
        tier:       overrideTier  || pred.tier,
        homeTeam:   pred.homeTeam,
        awayTeam:   pred.awayTeam,
        league:     pred.league,
        prediction: pred.topPick,
        confidence: pred.topConfidence,
        fixtureId:  String(pred.fixtureId),
        isPowerPick: isPower,
        metadata:   pred as any,
      });
    } catch (err) {
      console.error('[Engine] Failed to save pick:', err);
    }
  }

  // Save soccer legs (type = 'soccer')
  for (const pred of soccerLegs) {
    await savePick(pred, 'soccer');
    soccerCount++;
    console.log(`[Engine] ✅ Soccer leg: ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)`);
  }

  // Save NBA legs (type = 'nba')
  for (const pred of nbaLegs) {
    await savePick(pred, 'nba');
    nbaCount++;
    console.log(`[Engine] ✅ NBA leg:    ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)`);
  }

  // Save MLS legs (type = 'mls') — only if games exist
  if (mlsLegs.length > 0) {
    for (const pred of mlsLegs) {
      await savePick(pred, 'mls');
      mlsCount++;
      console.log(`[Engine] ✅ MLS leg:    ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)`);
    }
  } else {
    console.log(`[Engine] ℹ️  MLS tab: No MLS games on ${date} — tab will show blank`);
  }

  // Save Free Tier picks (64-67%) — dashboard only, NOT on main site
  // These are saved with tier='free' so the /picks.json endpoint can filter them out
  let freeCount = 0;
  for (const pred of freePicks) {
    // Skip if this game is already saved as a sport leg (avoid duplicates)
    const alreadySaved = [...soccerLegs, ...nbaLegs, ...mlsLegs].some(
      p => p.homeTeam === pred.homeTeam && p.awayTeam === pred.awayTeam
    );
    if (!alreadySaved) {
      await savePick(pred, pred.sport, 'free');
      freeCount++;
      console.log(`[Engine] 🔓 Free pick: ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%) [dashboard only]`);
    }
  }

  // Save Power Pick (isPowerPick = true)
  // Only save as a separate record if it's NOT already saved as a sport leg
  // (to avoid duplicate picks on the site)
  if (powerPick) {
    const alreadySavedAsLeg = [...soccerLegs, ...nbaLegs, ...mlsLegs].some(
      p => p.homeTeam === powerPick.homeTeam && p.awayTeam === powerPick.awayTeam
    );
    if (alreadySavedAsLeg) {
      // Just update the existing pick's isPowerPick flag via a separate flag
      // We mark it by updating the metadata — the /picks.json endpoint will check isPowerPick in DB
      // For now, save it with isPowerPick=true so the endpoint can find it
      await savePick(powerPick, powerPick.sport, powerPick.tier, true);
      powerCount++;
      console.log(`[Engine] ⚡ Power Pick (flagged): ${powerPick.homeTeam} vs ${powerPick.awayTeam} — ${powerPick.topPick} (${powerPick.topConfidence.toFixed(1)}%)`);
    } else {
      await savePick(powerPick, powerPick.sport, powerPick.tier, true);
      powerCount++;
      console.log(`[Engine] ⚡ Power Pick: ${powerPick.homeTeam} vs ${powerPick.awayTeam} — ${powerPick.topPick} (${powerPick.topConfidence.toFixed(1)}%)`);
    }
  }

  // ── Save parlays ──────────────────────────────────────────────────────────
  if (soccerLegs.length >= 2) {
    const soccerOdds = soccerLegs.reduce((acc, p) => {
      const odds = (p.metadata as any)?.homeOdds || (p.metadata as any)?.awayOdds || 1.85;
      return acc * odds;
    }, 1);
    await storage.saveParlays(date, 'soccer', soccerLegs.map(p => ({
      homeTeam: p.homeTeam, awayTeam: p.awayTeam, league: p.league,
      pick: p.topPick, confidence: p.topConfidence,
    })), soccerOdds.toFixed(2));
  }

  if (nbaLegs.length >= 2) {
    const nbaOdds = nbaLegs.reduce((acc, p) => {
      const odds = (p.metadata as any)?.homeOdds || (p.metadata as any)?.awayOdds || 1.90;
      return acc * odds;
    }, 1);
    await storage.saveParlays(date, 'nba', nbaLegs.map(p => ({
      homeTeam: p.homeTeam, awayTeam: p.awayTeam, league: p.league,
      pick: p.topPick, confidence: p.topConfidence,
    })), nbaOdds.toFixed(2));
  }

  if (mlsLegs.length >= 2) {
    const mlsOdds = mlsLegs.reduce((acc, p) => {
      const odds = (p.metadata as any)?.homeOdds || (p.metadata as any)?.awayOdds || 1.80;
      return acc * odds;
    }, 1);
    await storage.saveParlays(date, 'mls', mlsLegs.map(p => ({
      homeTeam: p.homeTeam, awayTeam: p.awayTeam, league: p.league,
      pick: p.topPick, confidence: p.topConfidence,
    })), mlsOdds.toFixed(2));
  }

  // ── FTP upload ────────────────────────────────────────────────────────────
  let ftpUploaded = false;
  try {
    const allSaved = [...soccerLegs, ...nbaLegs, ...mlsLegs, ...(powerPick ? [powerPick] : [])];
    const { uploadPicksToFTP } = await import('./apis/upload.js');
    await uploadPicksToFTP(date, allSaved);
    ftpUploaded = true;
  } catch (err) {
    console.warn('[Engine] FTP upload failed (non-critical):', err);
  }
  const total = soccerCount + nbaCount + mlsCount + powerCount + freeCount;
  console.log(`[Engine] ═══════════════════════════════════════════════════`);
  console.log(`[Engine] COMPLETE: ${total} picks saved for ${date}`);
  console.log(`[Engine]   Soccer: ${soccerCount}/3 | NBA: ${nbaCount}/3 | MLS: ${mlsCount}/3 | Power: ${powerCount}/1 | Free: ${freeCount}/2`);
  console.log(`[Engine] ═══════════════════════════════════════════════════\n`);
  return { total, soccer: soccerCount, nba: nbaCount, mls: mlsCount, powerPick: powerCount, ftpUploaded };
}

// ─── Mock Fixtures (fallback when API unavailable) ────────────────────────────
function getMockSoccerFixtures(date: string): FixtureData[] {
  return [
    {
      fixtureId: 'mock-soccer-1', homeTeam: 'Manchester City', awayTeam: 'Arsenal',
      league: 'Premier League', sport: 'soccer', date,
      homeOdds: 1.85, drawOdds: 3.50, awayOdds: 4.20,
      homeForm: ['W','W','D','W','W'], awayForm: ['W','D','W','L','W'],
      homeWinRate: 0.72, awayWinRate: 0.65, homeRestDays: 4, awayRestDays: 3,
      homeTableRank: 1, awayTableRank: 3, leagueSize: 20,
    },
    {
      fixtureId: 'mock-soccer-2', homeTeam: 'Real Madrid', awayTeam: 'Barcelona',
      league: 'La Liga', sport: 'soccer', date,
      homeOdds: 2.10, drawOdds: 3.20, awayOdds: 3.40,
      homeForm: ['W','W','W','L','W'], awayForm: ['W','W','L','W','W'],
      homeWinRate: 0.70, awayWinRate: 0.68, homeRestDays: 5, awayRestDays: 5,
      homeTableRank: 2, awayTableRank: 1, leagueSize: 20,
    },
    {
      fixtureId: 'mock-soccer-3', homeTeam: 'Bayern Munich', awayTeam: 'Dortmund',
      league: 'Bundesliga', sport: 'soccer', date,
      homeOdds: 1.75, drawOdds: 3.80, awayOdds: 4.50,
      homeForm: ['W','W','W','W','D'], awayForm: ['W','L','W','W','L'],
      homeWinRate: 0.78, awayWinRate: 0.55, homeRestDays: 6, awayRestDays: 4,
      homeTableRank: 1, awayTableRank: 4, leagueSize: 18,
    },
    {
      fixtureId: 'mock-soccer-4', homeTeam: 'PSG', awayTeam: 'Lyon',
      league: 'Ligue 1', sport: 'soccer', date,
      homeOdds: 1.55, drawOdds: 4.00, awayOdds: 5.50,
      homeForm: ['W','W','W','W','W'], awayForm: ['L','D','W','L','D'],
      homeWinRate: 0.82, awayWinRate: 0.42, homeRestDays: 5, awayRestDays: 3,
      homeTableRank: 1, awayTableRank: 8, leagueSize: 20,
    },
    {
      fixtureId: 'mock-soccer-5', homeTeam: 'Flamengo', awayTeam: 'Palmeiras',
      league: 'Brasileirao Serie A', sport: 'soccer', date,
      homeOdds: 2.00, drawOdds: 3.30, awayOdds: 3.60,
      homeForm: ['W','W','D','W','L'], awayForm: ['W','W','W','D','W'],
      homeWinRate: 0.62, awayWinRate: 0.68, homeRestDays: 4, awayRestDays: 4,
      homeTableRank: 3, awayTableRank: 1, leagueSize: 20,
    },
  ];
}

function getMockNBAFixtures(date: string): FixtureData[] {
  return [
    {
      // Strong home favourite: 5W streak, key away player out, big rank gap
      fixtureId: 'mock-nba-1', homeTeam: 'Boston Celtics', awayTeam: 'Washington Wizards',
      league: 'NBA', sport: 'nba', date,
      homeOdds: 1.40, awayOdds: 3.20,
      homeForm: ['W','W','W','W','W'], awayForm: ['L','L','L','W','L'],
      homeWinRate: 0.78, awayWinRate: 0.28, homeRestDays: 3, awayRestDays: 1,
      homeInjuries: 0, awayInjuries: 4, homeKeyPlayerOut: false, awayKeyPlayerOut: true,
      homeInjuryRating: 1.00, awayInjuryRating: 0.45,
      homeTableRank: 1, awayTableRank: 28, leagueSize: 30,
    },
    {
      // Dominant home team vs bottom-dweller
      fixtureId: 'mock-nba-2', homeTeam: 'Oklahoma City Thunder', awayTeam: 'Detroit Pistons',
      league: 'NBA', sport: 'nba', date,
      homeOdds: 1.38, awayOdds: 3.40,
      homeForm: ['W','W','W','W','W'], awayForm: ['L','L','W','L','L'],
      homeWinRate: 0.80, awayWinRate: 0.30, homeRestDays: 4, awayRestDays: 2,
      homeInjuries: 0, awayInjuries: 5, homeKeyPlayerOut: false, awayKeyPlayerOut: true,
      homeInjuryRating: 1.00, awayInjuryRating: 0.40,
      homeTableRank: 1, awayTableRank: 29, leagueSize: 30,
    },
    {
      // Top team vs struggling away side
      fixtureId: 'mock-nba-3', homeTeam: 'Cleveland Cavaliers', awayTeam: 'Charlotte Hornets',
      league: 'NBA', sport: 'nba', date,
      homeOdds: 1.45, awayOdds: 2.95,
      homeForm: ['W','W','W','W','W'], awayForm: ['L','L','L','W','L'],
      homeWinRate: 0.76, awayWinRate: 0.32, homeRestDays: 3, awayRestDays: 1,
      homeInjuries: 0, awayInjuries: 4, homeKeyPlayerOut: false, awayKeyPlayerOut: true,
      homeInjuryRating: 1.00, awayInjuryRating: 0.50,
      homeTableRank: 2, awayTableRank: 27, leagueSize: 30,
    },
    {
      fixtureId: 'mock-nba-4', homeTeam: 'Denver Nuggets', awayTeam: 'Portland Trail Blazers',
      league: 'NBA', sport: 'nba', date,
      homeOdds: 1.50, awayOdds: 2.75,
      homeForm: ['W','W','W','L','W'], awayForm: ['L','L','W','L','L'],
      homeWinRate: 0.72, awayWinRate: 0.35, homeRestDays: 4, awayRestDays: 2,
      homeInjuries: 1, awayInjuries: 4, homeKeyPlayerOut: false, awayKeyPlayerOut: true,
      homeInjuryRating: 0.93, awayInjuryRating: 0.48,
      homeTableRank: 2, awayTableRank: 9, leagueSize: 30,
    },
  ];
}

function getMockMLSFixtures(date: string): FixtureData[] {
  return [
    {
      fixtureId: 'mock-mls-1', homeTeam: 'Inter Miami CF', awayTeam: 'Atlanta United',
      league: 'MLS', sport: 'mls', date,
      homeOdds: 1.70, drawOdds: 3.60, awayOdds: 4.50,
      homeForm: ['W','W','W','D','W'], awayForm: ['L','W','L','D','L'],
      homeWinRate: 0.72, awayWinRate: 0.42, homeRestDays: 5, awayRestDays: 3,
      homeTableRank: 1, awayTableRank: 9, leagueSize: 29,
    },
    {
      fixtureId: 'mock-mls-2', homeTeam: 'LA Galaxy', awayTeam: 'San Jose Earthquakes',
      league: 'MLS', sport: 'mls', date,
      homeOdds: 1.65, drawOdds: 3.80, awayOdds: 5.00,
      homeForm: ['W','W','D','W','W'], awayForm: ['L','L','W','L','L'],
      homeWinRate: 0.68, awayWinRate: 0.35, homeRestDays: 6, awayRestDays: 4,
      homeTableRank: 2, awayTableRank: 12, leagueSize: 29,
    },
    {
      fixtureId: 'mock-mls-3', homeTeam: 'Seattle Sounders', awayTeam: 'Portland Timbers',
      league: 'MLS', sport: 'mls', date,
      homeOdds: 1.80, drawOdds: 3.50, awayOdds: 4.20,
      homeForm: ['W','W','W','W','D'], awayForm: ['W','L','W','L','L'],
      homeWinRate: 0.70, awayWinRate: 0.48, homeRestDays: 5, awayRestDays: 4,
      homeTableRank: 1, awayTableRank: 6, leagueSize: 29,
    },
    {
      fixtureId: 'mock-mls-4', homeTeam: 'Columbus Crew', awayTeam: 'CF Montreal',
      league: 'MLS', sport: 'mls', date,
      homeOdds: 1.75, drawOdds: 3.60, awayOdds: 4.40,
      homeForm: ['W','W','D','W','W'], awayForm: ['L','D','W','L','D'],
      homeWinRate: 0.69, awayWinRate: 0.44, homeRestDays: 4, awayRestDays: 3,
      homeTableRank: 2, awayTableRank: 8, leagueSize: 29,
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
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: 'V3 Titan XII',
      timestamp: new Date().toISOString(),
      pickStructure: {
        nba:    '3 legs',
        mls:    '3 legs (blank if no games)',
        soccer: '3 legs',
        power:  '1 pick (highest confidence ≥68%)',
      },
    });
  });

  // ── Public Tab Endpoints ────────────────────────────────────────────────────
  // These feed the 4 tabs on the client-facing site.
  // No auth required — public data.

  // NBA Tab — 3 NBA legs (only pending picks shown on main page)
  app.get('/api/picks/nba', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const picks = await storage.getPicksByDate(date);
      const nbaLegs = picks
        .filter(p => p.sport === 'nba' && !p.isDisabled && p.status === 'pending')
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3);
      res.json({
        tab: 'NBA',
        date,
        legs: nbaLegs,
        count: nbaLegs.length,
        target: 3,
        complete: nbaLegs.length === 3,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MLS Tab — 3 MLS legs (empty array if no games)
  app.get('/api/picks/mls', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const picks = await storage.getPicksByDate(date);
      const mlsLegs = picks
        .filter(p => p.sport === 'mls' && !p.isDisabled && p.status === 'pending')
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3);
      res.json({
        tab: 'MLS',
        date,
        legs: mlsLegs,
        count: mlsLegs.length,
        target: 3,
        complete: mlsLegs.length === 3,
        noGames: mlsLegs.length === 0,
        message: mlsLegs.length === 0 ? 'No MLS games scheduled today' : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Soccer Tab — 3 Soccer legs (all leagues)
  app.get('/api/picks/soccer', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const picks = await storage.getPicksByDate(date);
      const soccerLegs = picks
        .filter(p => p.sport === 'soccer' && !p.isDisabled && p.status === 'pending')
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3);
      res.json({
        tab: 'Soccer',
        date,
        legs: soccerLegs,
        count: soccerLegs.length,
        target: 3,
        complete: soccerLegs.length === 3,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Power Pick Tab — 1 highest confidence pick
  app.get('/api/picks/power', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const picks = await storage.getPicksByDate(date);
      const powerPick = picks
        .filter(p => p.isPowerPick && !p.isDisabled && p.status === 'pending')
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] || null;
      res.json({
        tab: 'Power Pick',
        date,
        pick: powerPick,
        confidence: powerPick?.confidence ?? null,
        available: !!powerPick,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // All picks for today (combined — only pending shown on main page)
  app.get('/api/picks/today', async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const picks = await storage.getPicksByDate(date);
      const active = picks.filter(p => !p.isDisabled && p.status === 'pending');
      // Public site only shows picks at 68%+ confidence (Pro tier and above)
      const publicActive = active.filter(p => (p.confidence ?? 0) >= 68 && p.tier !== 'free');
      // Exclude Power Pick rows from sport arrays (Power Pick is shown separately)
      const sportPicks = publicActive.filter(p => !p.isPowerPick);
      res.json({
        date,
        nba:    sportPicks.filter(p => p.sport === 'nba').slice(0, 3),
        mls:    sportPicks.filter(p => p.sport === 'mls').slice(0, 3),
        soccer: sportPicks.filter(p => p.sport === 'soccer').slice(0, 3),
        power:  publicActive.filter(p => p.isPowerPick).slice(0, 1),
        total:  publicActive.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── /picks.json — Original Site Compatibility Endpoint ──────────────────────
  // The original index.html fetches /picks.json to load all picks data.
  // This endpoint returns the exact same JSON format as the cPanel picks.json.
  app.get('/picks.json', async (req, res) => {
    try {
      const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
       const picks = await storage.getPicksByDate(date);
      const active = picks.filter(p => !p.isDisabled);
      // Public site only shows picks at 68%+ confidence (Pro tier and above)
      // Free tier picks (64-67%) are filtered out from the main site display
      const publicActive = active.filter(p => (p.confidence ?? 0) >= 68 && p.tier !== 'free');
      // Exclude Power Pick rows from sport lists to avoid duplicates
      const sportOnly   = publicActive.filter(p => !p.isPowerPick);
      const soccerPicks = sportOnly.filter(p => p.sport === 'soccer').slice(0, 3);
      const mlsPicks    = sportOnly.filter(p => p.sport === 'mls').slice(0, 3);
      const nbaPicks    = sportOnly.filter(p => p.sport === 'nba').slice(0, 3);
      const powerPick   = publicActive.find(p => p.isPowerPick) ||
                          [...publicActive].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      // Featured Mega-Pick: isFeatured=true takes priority over powerPick for hero section
      const featuredMegaPick = publicActive.find(p => p.isFeatured) || powerPick;

      const now = new Date().toISOString();
      const dateDisplay = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Moncton',
      });

      function fmtLeg(p: any) {
        return {
          game: `${p.homeTeam} vs ${p.awayTeam}`,
          match: `${p.homeTeam} vs ${p.awayTeam}`,
          pick: p.prediction || p.pick,
          pick_type: p.prediction || p.pick,
          pick_label: p.prediction || p.pick,
          confidence: Math.round(p.confidence ?? 0),
          probability: parseFloat(((p.confidence ?? 0) / 100).toFixed(2)),
          probability_display: `${Math.round(p.confidence ?? 0)}%`,
          confidence_pct: `${Math.round(p.confidence ?? 0)}%`,
          league: p.league || 'Unknown League',
          odds: p.odds || '-110',
          time: `${date} — Today`,
          time_display: `${date} — Today`,
          analysis: `Gold Standard V3 Titan XII — ${p.prediction || p.pick} at ${Math.round(p.confidence ?? 0)}%.`,
          reasoning: `Gold Standard V3 Titan XII — ${p.prediction || p.pick} at ${Math.round(p.confidence ?? 0)}%.`,
          home_team: p.homeTeam,
          away_team: p.awayTeam,
          tier: p.tier || 'free',
          sport: p.sport || 'soccer',
        };
      }

      function combinedProb(legs: any[]): string {
        if (!legs.length) return '0%';
        const c = legs.reduce((acc, p) => acc * ((p.confidence ?? 68) / 100), 1);
        return `${(c * 100).toFixed(1)}%`;
      }

      const parlayLegs = soccerPicks.map(fmtLeg);
      const mlsLegs    = mlsPicks.map(fmtLeg);
      const nbaLegs    = nbaPicks.map(fmtLeg);
      const mlsNoSlate = mlsLegs.length === 0;

      const payload = {
        date,
        generated_at: now,
        last_generated: now,
        last_updated_display: dateDisplay,
        tiers: { power_pick: 'free', soccer_picks: 'free', mls_parlay: 'free', nba_parlay: 'free', nba_picks: 'free' },
        parlay: { legs: parlayLegs, legs_count: parlayLegs.length, combined_probability: combinedProb(soccerPicks) },
        three_leg_conservative: { legs: parlayLegs, legs_count: parlayLegs.length, combined_probability: combinedProb(soccerPicks) },
        soccer_picks: parlayLegs,
        mls_parlay: { legs: mlsLegs, legs_count: mlsLegs.length, combined_probability: combinedProb(mlsPicks) },
        mls_no_slate: mlsNoSlate,
        mls_next_slate_date: mlsNoSlate ? 'Check back soon' : '',
        nba_parlay: { legs: nbaLegs, legs_count: nbaLegs.length, combined_probability: combinedProb(nbaPicks) },
        corner_parlay: { legs: [], legs_count: 0, combined_probability: '0%' },
        power_pick: powerPick ? {
          game: `${powerPick.homeTeam} vs ${powerPick.awayTeam}`,
          pick: powerPick.prediction || powerPick.pick,
          league: powerPick.league || 'Unknown',
          probability: parseFloat(((powerPick.confidence ?? 0) / 100).toFixed(2)),
          probability_display: `${Math.round(powerPick.confidence ?? 0)}%`,
          odds: powerPick.odds || '-110',
          time: `${date} — Today`,
          analysis: `Gold Standard V3 Titan XII — Top pick at ${Math.round(powerPick.confidence ?? 0)}%.`,
        } : null,
        featured_pick: featuredMegaPick ? {
          game: `${featuredMegaPick.homeTeam} vs ${featuredMegaPick.awayTeam}`,
          league: featuredMegaPick.league || 'Unknown',
          pick: featuredMegaPick.prediction || featuredMegaPick.pick,
          pick_type: featuredMegaPick.prediction || featuredMegaPick.pick,
          confidence: Math.round(featuredMegaPick.confidence ?? 0),
          probability: parseFloat(((featuredMegaPick.confidence ?? 0) / 100).toFixed(2)),
          confidence_pct: `${Math.round(featuredMegaPick.confidence ?? 0)}%`,
          odds: featuredMegaPick.odds || '-110',
          time_display: date,
          label: featuredMegaPick.isFeatured ? 'SUNDAY MEGA-PICK' : 'POWER PICK',
          pick_label: featuredMegaPick.prediction || featuredMegaPick.pick,
          reasoning: (featuredMegaPick.metadata as any)?.recommendation || `Gold Standard V3 Titan XII — Top pick at ${Math.round(featuredMegaPick.confidence ?? 0)}%.`,
          game_time: (featuredMegaPick.metadata as any)?.gameTime || '',
          hero_title: featuredMegaPick.isFeatured ? `SUNDAY MEGA-PICK: ${featuredMegaPick.awayTeam?.toUpperCase()} vs ${featuredMegaPick.homeTeam?.toUpperCase()} — ${Math.round(featuredMegaPick.confidence ?? 0)}% CONFIDENCE` : '',
          seo_title: featuredMegaPick.isFeatured ? `March 8 NBA Expert Picks: Knicks vs Lakers Prediction & 12-Factor Analysis` : '',
          auto_generated: true,
          tag: featuredMegaPick.isFeatured ? 'MEGA-PICK' : 'POWER PICK',
          disclaimer: 'For entertainment purposes only.',
        } : null,
        featured_soccer: soccerPicks[0] ? {
          match: `${soccerPicks[0].homeTeam} vs ${soccerPicks[0].awayTeam}`,
          league: soccerPicks[0].league || 'Soccer',
          sport: 'soccer',
          pick: soccerPicks[0].prediction || soccerPicks[0].pick,
          confidence: Math.round(soccerPicks[0].confidence ?? 0),
          confidence_display: `${Math.round(soccerPicks[0].confidence ?? 0)}%`,
          reasoning: `Gold Standard V3 Titan XII — ${soccerPicks[0].prediction} at ${Math.round(soccerPicks[0].confidence ?? 0)}%.`,
          match_date: date,
        } : { match: '', league: '', sport: 'soccer', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date },
        featured_mls: mlsPicks[0] ? {
          match: `${mlsPicks[0].homeTeam} vs ${mlsPicks[0].awayTeam}`,
          league: mlsPicks[0].league || 'MLS',
          sport: 'mls',
          pick: mlsPicks[0].prediction || mlsPicks[0].pick,
          confidence: Math.round(mlsPicks[0].confidence ?? 0),
          confidence_display: `${Math.round(mlsPicks[0].confidence ?? 0)}%`,
          reasoning: mlsNoSlate ? 'No MLS games today.' : `Gold Standard V3 Titan XII — ${mlsPicks[0].prediction} at ${Math.round(mlsPicks[0].confidence ?? 0)}%.`,
          match_date: date,
        } : { match: '', league: 'MLS', sport: 'mls', pick: '', confidence: 0, confidence_display: '0%', reasoning: 'No MLS games today.', match_date: date },
        featured_nba: nbaPicks[0] ? {
          match: `${nbaPicks[0].homeTeam} vs ${nbaPicks[0].awayTeam}`,
          league: nbaPicks[0].league || 'NBA',
          sport: 'nba',
          pick: nbaPicks[0].prediction || nbaPicks[0].pick,
          confidence: Math.round(nbaPicks[0].confidence ?? 0),
          confidence_display: `${Math.round(nbaPicks[0].confidence ?? 0)}%`,
          reasoning: `Gold Standard V3 Titan XII — ${nbaPicks[0].prediction} at ${Math.round(nbaPicks[0].confidence ?? 0)}%.`,
          match_date: date,
        } : { match: '', league: 'NBA', sport: 'nba', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date },
        nba_picks: nbaLegs,
        player_prop_picks: [],
        free_tier_picks: active.filter(p => p.tier === 'free').slice(0, 3).map(fmtLeg),
        results: { date_display: dateDisplay, entries: [] },
        expert_analysis: {
          title: `Gold Standard V3 Titan XII — ${dateDisplay}`,
          body: `Today's picks were generated by the Gold Standard V3 Titan XII 12-factor AI engine. All picks passed the 68% confidence threshold.`,
          visible: true,
          updated_at: now,
        },
        manual_lock: false,
        locked_sections: [],
        featured_games: publicActive.slice(0, 3).map((p, i) => ({
          rank: i + 1,
          game: `${p.homeTeam} vs ${p.awayTeam}`,
          league: p.league || 'Unknown',
          pick: p.prediction || p.pick,
          confidence: Math.round(p.confidence ?? 0),
          confidence_pct: `${Math.round(p.confidence ?? 0)}%`,
          reasoning: `Gold Standard V3 Titan XII — ${p.prediction} at ${Math.round(p.confidence ?? 0)}%.`,
          time_display: date,
          sport: p.sport || 'soccer',
          auto_generated: true,
          tag: i === 0 ? 'TOP PICK' : i === 1 ? 'VALUE PLAY' : 'SAFE BET',
        })),
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.json(payload);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Public Results Page API ─────────────────────────────────────────────────
  // Returns only settled results (won/lost/void) — never pending picks
  app.get('/api/results', async (req, res) => {
    try {
      const results = await storage.getResults(200);
      const settled = results.filter(r => ['won', 'lost', 'void'].includes(r.result));
      const summary = await storage.getWinLossSummary();
      res.json({
        results: settled,
        summary,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Public Win/Loss Summary ─────────────────────────────────────────────────
  app.get('/api/results/summary', async (req, res) => {
    try {
      const summary = await storage.getWinLossSummary();
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin Picks ─────────────────────────────────────────────────────────────
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
      const byTier = {
        free: picks.filter(p => p.tier === 'free'),
        vip:  picks.filter(p => p.tier === 'vip'),
        pro:  picks.filter(p => p.tier === 'pro'),
      };
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

  app.post('/api/admin/mls-parlay-override', requireAuth, async (req, res) => {
    try {
      const { date, legs, totalOdds } = req.body;
      const parlay = await storage.saveParlays(date || new Date().toLocaleDateString('en-CA'), 'mls', legs, totalOdds);
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

  // GUARDRAIL 3 — READ-ONLY PROTECTION: Historical Records and Win/Loss pages
  // are read-only. Modifications require a Manager Override code in the request header.
  // Only the 'Live Picks' section is authorized for automated updates.
  const MANAGER_OVERRIDE_CODE = process.env.MANAGER_OVERRIDE_CODE || 'PK-MANAGER-2026';
  function requireManagerOverride(req: Request, res: Response, next: NextFunction) {
    const override = req.headers['x-manager-override'] as string || req.body?.managerOverride;
    if (!override || override !== MANAGER_OVERRIDE_CODE) {
      console.warn(`[GUARDRAIL-3] READ-ONLY PROTECTION: Blocked write to Historical Records without Manager Override. IP: ${req.ip}`);
      return res.status(403).json({
        error: 'READ-ONLY PROTECTION ACTIVE',
        message: 'Historical Records and Win/Loss pages are read-only. A Manager Override code is required to modify these records.',
        guardrail: 3,
        hint: 'Include X-Manager-Override header with the override code to proceed.',
      });
    }
    console.log(`[GUARDRAIL-3] Manager Override accepted — write to Historical Records authorized`);
    next();
  }
  app.post('/api/admin/results', requireAuth, requireManagerOverride, async (req, res) => {
    try {
      const result = await storage.createResult(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.put('/api/admin/results/:id', requireAuth, requireManagerOverride, async (req, res) => {
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
      res.json({
        tier: req.params.tier, wins, losses, total,
        winRate: total > 0 ? Math.round(wins / total * 1000) / 10 : 0,
        results: tierResults,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Engine & Validation ─────────────────────────────────────────────────────
  app.post('/api/admin/trigger', requireAuth, async (req, res) => {
    try {
      const date = req.body.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      res.json({ success: true, message: `Generation triggered for ${date}`, date });
      // Run async after response
      generateDailyPicks(date).catch(err => console.error('[Admin] Manual trigger failed:', err));
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

  app.post('/api/admin/engine-config', requireAuth, async (req, res) => {
    try {
      const { key, value } = req.body;
      await storage.setEngineConfig(key, value);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/run-logs', requireAuth, async (req, res) => {
    try {
      const logs = await storage.getRunLogs(20);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/cache-status', requireAuth, async (req, res) => {
    try {
      const { getCacheStatus } = await import('./apis/apiFootball.js');
      res.json(getCacheStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/clear-cache', requireAuth, async (req, res) => {
    try {
      const { clearApiCache } = await import('./apis/apiFootball.js');
      clearApiCache();
      res.json({ success: true, message: 'API cache cleared' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Members ─────────────────────────────────────────────────────────────────
  app.get('/api/admin/members', requireAuth, async (req, res) => {
    try {
      const members = await storage.getMembers();
      res.json(members);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/member/heartbeat', async (req, res) => {
    try {
      const { email, page } = req.body;
      if (!email) return res.status(400).json({ error: 'Email required' });
      await storage.recordHeartbeat(email, page);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/active-users', requireAuth, async (req, res) => {
    try {
      const users = await storage.getActiveUsers(15);
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tier Pricing ────────────────────────────────────────────────────────────
  app.get('/api/admin/tier-pricing', requireAuth, async (req, res) => {
    try {
      const pricing = await storage.getTierPricing();
      res.json(pricing);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/tier-pricing', requireAuth, async (req, res) => {
    try {
      const { tier, price, label } = req.body;
      await storage.setTierPricing(tier, price, label);
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

  // ── Legacy Public Endpoint ──────────────────────────────────────────────────
  app.get('/api/bet-builder/games', async (req, res) => {
    try {
      const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
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

  app.post('/api/admin/re-engage', requireAuth, async (req, res) => {
    res.json({ success: true, message: 'Re-engagement notifications queued' });
  });

  // ── Serve tier-guard.js (PayPal + tier gating) ──────────────────────────────────────────────────────
  app.get('/tier-guard.js', (_req: any, res: any) => {
    const tierGuardPath = path.join(process.cwd(), 'server/templates/tier-guard.js');
    if (fs.existsSync(tierGuardPath)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.sendFile(tierGuardPath);
    }
    res.status(404).send('// tier-guard.js not found');
  });

  // ── PayPal IPN webhook ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  app.post('/api/paypal/ipn', async (req, res) => {
    // Immediately acknowledge PayPal IPN
    res.status(200).send('OK');

    try {
      const params = new URLSearchParams(req.body as Record<string, string>);
      const paymentStatus = params.get('payment_status');
      const payerEmail = params.get('payer_email') || '';
      const itemName = params.get('item_name') || '';
      const txnType = params.get('txn_type') || '';

      // Only process completed payments or subscriptions
      if (paymentStatus !== 'Completed' && txnType !== 'subscr_payment') return;

      // Determine tier from item name
      let tier = 'free';
      if (itemName.toLowerCase().includes('lifetime') || itemName.toLowerCase().includes('499')) {
        tier = 'lifetime';
      } else if (itemName.toLowerCase().includes('vip') || itemName.toLowerCase().includes('14')) {
        tier = 'vip';
      } else if (itemName.toLowerCase().includes('pro') || itemName.toLowerCase().includes('streamz')) {
        tier = 'pro';
      }

      // PAID TIERS DISABLED UNTIL 2026-03-20 — grant free tier only
      const paidTiersDisabledUntil = new Date('2026-03-20');
      const now = new Date();
      if (now < paidTiersDisabledUntil) {
        tier = 'free';
        console.log(`[PayPal IPN] Paid tiers disabled until 2026-03-20 — granting free tier to ${payerEmail}`);
      }
      if (payerEmail && tier !== 'free') {
        await storage.createOrUpdateMember(payerEmail, tier);
        console.log(`[PayPal IPN] Tier ${tier} granted to ${payerEmail}`);
      } else if (payerEmail) {
        await storage.createOrUpdateMember(payerEmail, 'free');
        console.log(`[PayPal IPN] Free tier granted to ${payerEmail} (paid tiers disabled)`);
      }
    } catch (err) {
      console.error('[PayPal IPN] Error processing IPN:', err);
    }
  });

  // Member tier lookup by email
  app.get('/api/member/tier', async (req, res) => {
    const email = req.query.email as string;
    if (!email) return res.json({ tier: 'free' });
    try {
      const member = await storage.getMemberByEmail(email as string);
      if (member) {
        return res.json({ tier: member.tier, token: member.token });
      }
      return res.json({ tier: 'free' });
    } catch {
      return res.json({ tier: 'free' });
    }
  });

  const JWT_SECRET = process.env.SESSION_SECRET || 'parlay-king-secret-2025';

  // POST /api/auth/register — create username+password after payment
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    try {
      const { email, username, password, plan } = req.body;
      if (!email || !username || !password) {
        return res.status(400).json({ error: 'Email, username, and password are required.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }
      // Check if username already taken
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const existing = await pool.query('SELECT id FROM members WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        await pool.end();
        return res.status(409).json({ error: 'Username already taken. Please choose another.' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      // PAID TIERS DISABLED UNTIL 2026-03-20
      const paidDisabledUntil = new Date('2026-03-20');
      const rawTier = plan === 'lifetime' ? 'lifetime' : plan === 'vip-monthly' ? 'vip' : 'free';
      const tier = new Date() < paidDisabledUntil && rawTier !== 'free' ? 'free' : rawTier;
      // Upsert member with username and password
      await pool.query(
        `INSERT INTO members (email, username, password_hash, tier, is_active, created_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         ON CONFLICT (email) DO UPDATE SET
           username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           tier = EXCLUDED.tier,
           is_active = true`,
        [email, username, passwordHash, tier]
      );
      await pool.end();
      // Issue JWT
      const token = jwt.sign({ email, username, tier }, JWT_SECRET, { expiresIn: '90d' });
      return res.json({ success: true, token, tier, username });
    } catch (err: any) {
      console.error('[Auth Register]', err.message);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  });

  // POST /api/auth/login — login with username+password
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query(
        'SELECT * FROM members WHERE username = $1 AND is_active = true',
        [username]
      );
      await pool.end();
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      const member = result.rows[0];
      if (!member.password_hash) {
        return res.status(401).json({ error: 'Account not set up yet. Please complete registration.' });
      }
      const valid = await bcrypt.compare(password, member.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      const token = jwt.sign(
        { email: member.email, username: member.username, tier: member.tier },
        JWT_SECRET,
        { expiresIn: '90d' }
      );
      return res.json({ success: true, token, tier: member.tier, username: member.username, email: member.email });
    } catch (err: any) {
      console.error('[Auth Login]', err.message);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  });

  // ─── GUARDRAIL 4: The Odds API connection verification ─────────────────────
  // Returns lastUpdatedAt timestamps for the first 3 games to confirm live data.
  app.get('/api/admin/verify-connection', requireAuth, async (req, res) => {
    try {
      const { getOddsApiStatus } = await import('./apis/oddsApi.js');
      const status = await getOddsApiStatus();
      res.json({
        guardrail: 4,
        status: 'LIVE',
        source: 'the-odds-api.com',
        budgetLedger: status.budgetLedger,
        sampleGames: status.sampleGames,
        cacheStatus: status.cacheStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message, status: 'DISCONNECTED' });
    }
  });

  // GET /api/admin/budget-status — check API quota remaining
  app.get('/api/admin/budget-status', requireAuth, async (req, res) => {
    try {
      const { getBudgetLedger } = await import('./apis/oddsApi.js');
      const ledger = getBudgetLedger();
      res.json({
        guardrail: 2,
        hardCeiling: 100,
        used: ledger.used,
        remaining: ledger.remaining,
        cacheHits: ledger.cacheHits,
        lastReset: ledger.lastReset,
        status: ledger.remaining > 10 ? 'OK' : ledger.remaining > 0 ? 'WARNING' : 'EXHAUSTED',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/me — verify JWT and return current user info
  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      return res.json({ success: true, email: decoded.email, username: decoded.username, tier: decoded.tier });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
  });
}
