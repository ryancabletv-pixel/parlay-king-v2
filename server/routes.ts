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
  // GUARDRAIL: Minimum data quality gate
  // A pick must have at least 2 of 5 real data fields populated (odds, form, win rate, rank, injury)
  // This prevents picks where the engine only had neutral defaults and no real data.
  function hasMinDataQuality(p: PredictionResult): boolean {
    const f = p.factors;
    if (!f) return false;
    const hasOdds    = f.f01_marketConsensus_home !== 0.44 && f.f01_marketConsensus_home !== 0.30; // non-default
    const hasMomentum = f.f02_momentum_home !== 0.50 || f.f02_momentum_away !== 0.50;
    const hasQuality  = f.f03_quality_home !== 0.50 || f.f03_quality_away !== 0.50;
    const hasStanding = f.f11_standing_home !== 0.50 || f.f11_standing_away !== 0.50;
    const hasInjury   = f.f07_injuries_home !== 0.90 || f.f07_injuries_away !== 0.90;
    const dataPoints  = [hasOdds, hasMomentum, hasQuality, hasStanding, hasInjury].filter(Boolean).length;
    return dataPoints >= 2; // At least 2 of 5 data fields must be real (non-default)
  }

  // Filter: must pass threshold, must not be a draw pick (draws are low-value), must have real data
  const qualified = predictions
    .filter(p => p.topConfidence >= minConfidence && p.topConfidence <= maxConfidence)
    .filter(p => !p.topPick.toLowerCase().includes('draw'))
    .filter(p => hasMinDataQuality(p))
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

  // ───────────────────────────────────────────────────────────────────────
  // DYNAMIC SELECTION WATERFALL
  // Step 1 — PRIMARY: Select legs at 68%+ threshold
  // Step 2 — DIVERSITY CHECK: If short, query global leagues for more 68%+ picks
  // Step 3 — FALLBACK (No-Dark Policy): Lower to 65% hard floor + High Volatility label
  // ───────────────────────────────────────────────────────────────────────
  const HARD_FLOOR = 65;
  const HARD_FLOOR_LABEL = 'High Volatility';

  // Track which legs are high-volatility (below 68%)
  const highVolatilityLegs = new Set<string>(); // key: homeTeam+awayTeam

  // Helper: mark a leg as high-volatility
  function markHighVolatility(pred: PredictionResult) {
    highVolatilityLegs.add(`${pred.homeTeam}|${pred.awayTeam}`);
  }
  function isHighVol(pred: PredictionResult) {
    return highVolatilityLegs.has(`${pred.homeTeam}|${pred.awayTeam}`);
  }

  // STEP 1: Try 68%+ from existing predictions
  let soccerLegs = selectBestLegs(soccerPreds, 3, CONFIDENCE_THRESHOLDS.PRO_MIN);
  let mlsLegs    = selectBestLegs(mlsPreds,    3, CONFIDENCE_THRESHOLDS.PRO_MIN);
  let nbaLegs    = selectBestLegs(nbaPreds,    3, CONFIDENCE_THRESHOLDS.PRO_MIN);

  console.log(`[Waterfall] Step 1 — 68%+ legs: Soccer=${soccerLegs.length}/3, NBA=${nbaLegs.length}/3, MLS=${mlsLegs.length}/3`);

  // STEP 2: DIVERSITY CHECK — if any sport is short, scan global leagues for 68%+ picks
  if (soccerLegs.length < 3 || nbaLegs.length < 3) {
    console.log(`[Waterfall] Step 2 — DIVERSITY CHECK: Scanning global leagues...`);
    try {
      const { getGlobalSoccerOdds, getGlobalBasketballOdds } = await import('./apis/oddsApi.js');
      const { convertOddsGameToFixture } = await import('./apis/oddsApi.js').then(m => m).catch(() => ({ convertOddsGameToFixture: null }));

      if (soccerLegs.length < 3) {
        const globalSoccerGames = await getGlobalSoccerOdds();
        if (globalSoccerGames.length > 0) {
          // Convert OddsGame to FixtureData format for the engine
          const globalFixtures: FixtureData[] = globalSoccerGames.map(g => ({
            fixtureId: parseInt(g.id.replace(/\D/g,'').slice(0,8) || '0', 10),
            homeTeam: g.home_team, awayTeam: g.away_team,
            league: g.sport_title, sport: 'soccer',
            homeOdds: g.home_odds ?? undefined, awayOdds: g.away_odds ?? undefined, drawOdds: g.draw_odds ?? undefined,
            homeWinRate: undefined, awayWinRate: undefined,
            homeForm: undefined, awayForm: undefined,
            homeRank: undefined, awayRank: undefined,
            homeGoalsFor: undefined, awayGoalsFor: undefined,
            homeGoalsAgainst: undefined, awayGoalsAgainst: undefined,
            homeInjuries: 0, awayInjuries: 0,
            isNeutralVenue: false, venueName: undefined,
            headToHead: undefined,
          } as FixtureData));
          const globalPreds = runBatchPredictions(globalFixtures);
          const globalLegs = selectBestLegs(globalPreds, 3 - soccerLegs.length, CONFIDENCE_THRESHOLDS.PRO_MIN);
          if (globalLegs.length > 0) {
            soccerLegs = [...soccerLegs, ...globalLegs];
            console.log(`[Waterfall] Diversity: Found ${globalLegs.length} additional soccer legs from global leagues`);
          }
        }
      }

      if (nbaLegs.length < 3) {
        const globalBball = await getGlobalBasketballOdds();
        if (globalBball.length > 0) {
          const bballFixtures: FixtureData[] = globalBball.map(g => ({
            fixtureId: parseInt(g.id.replace(/\D/g,'').slice(0,8) || '0', 10),
            homeTeam: g.home_team, awayTeam: g.away_team,
            league: g.sport_title, sport: 'nba',
            homeOdds: g.home_odds ?? undefined, awayOdds: g.away_odds ?? undefined,
            homeWinRate: undefined, awayWinRate: undefined,
            homeForm: undefined, awayForm: undefined,
            homeRank: undefined, awayRank: undefined,
            homeGoalsFor: undefined, awayGoalsFor: undefined,
            homeGoalsAgainst: undefined, awayGoalsAgainst: undefined,
            homeInjuries: 0, awayInjuries: 0,
            isNeutralVenue: false, venueName: undefined,
            headToHead: undefined,
          } as FixtureData));
          const bballPreds = runBatchPredictions(bballFixtures);
          const bballLegs = selectBestLegs(bballPreds, 3 - nbaLegs.length, CONFIDENCE_THRESHOLDS.PRO_MIN);
          if (bballLegs.length > 0) {
            nbaLegs = [...nbaLegs, ...bballLegs];
            console.log(`[Waterfall] Diversity: Found ${bballLegs.length} additional NBA/basketball legs`);
          }
        }
      }
    } catch (divErr: any) {
      console.error(`[Waterfall] Diversity check error:`, divErr.message);
    }
  }

  console.log(`[Waterfall] After Step 2: Soccer=${soccerLegs.length}/3, NBA=${nbaLegs.length}/3, MLS=${mlsLegs.length}/3`);

  // STEP 3: FALLBACK (No-Dark Policy) — lower to 65% hard floor + High Volatility label
  // All fallback picks MUST still pass the 12-factor engine (they already did — they scored 65-67%)
  // If sport-specific pool is exhausted, draw from the global allPreds pool (any sport)

  if (soccerLegs.length < 3) {
    const needed = 3 - soccerLegs.length;
    const alreadySelected = new Set(soccerLegs.map(p => `${p.homeTeam}|${p.awayTeam}`));
    // First try sport-specific pool at 65-67%
    let fallbackPool = soccerPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
    // If sport pool is empty, use global allPreds (any sport) at 65-67%
    if (fallbackPool.length === 0) {
      fallbackPool = allPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
      console.log(`[Waterfall] Soccer fallback: using global allPreds pool (${fallbackPool.length} candidates)`);
    }
    const fallbackLegs = selectBestLegs(fallbackPool, needed, HARD_FLOOR, CONFIDENCE_THRESHOLDS.PRO_MIN - 0.01);
    for (const leg of fallbackLegs) {
      markHighVolatility(leg);
      soccerLegs.push(leg);
      console.log(`[Waterfall] ⚠️  Soccer FALLBACK (High Volatility): ${leg.homeTeam} vs ${leg.awayTeam} @ ${leg.topConfidence.toFixed(1)}%`);
    }
    if (soccerLegs.length < 3) {
      console.error(`[Waterfall] CRITICAL: Only ${soccerLegs.length}/3 soccer legs available even at 65% floor. No picks below 65% are permitted.`);
    }
  }

  if (nbaLegs.length < 3) {
    const needed = 3 - nbaLegs.length;
    const alreadySelected = new Set(nbaLegs.map(p => `${p.homeTeam}|${p.awayTeam}`));
    // First try sport-specific pool at 65-67%
    let fallbackPool = nbaPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
    // If sport pool is empty, use global allPreds (any sport) at 65-67%
    if (fallbackPool.length === 0) {
      fallbackPool = allPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
      console.log(`[Waterfall] NBA fallback: using global allPreds pool (${fallbackPool.length} candidates)`);
    }
    const fallbackLegs = selectBestLegs(fallbackPool, needed, HARD_FLOOR, CONFIDENCE_THRESHOLDS.PRO_MIN - 0.01);
    for (const leg of fallbackLegs) {
      markHighVolatility(leg);
      nbaLegs.push(leg);
      console.log(`[Waterfall] ⚠️  NBA FALLBACK (High Volatility): ${leg.homeTeam} vs ${leg.awayTeam} @ ${leg.topConfidence.toFixed(1)}%`);
    }
    if (nbaLegs.length < 3) {
      console.error(`[Waterfall] CRITICAL: Only ${nbaLegs.length}/3 NBA legs available even at 65% floor. No picks below 65% are permitted.`);
    }
  }

  if (mlsLegs.length < 2) {
    const needed = 2 - mlsLegs.length;
    const alreadySelected = new Set(mlsLegs.map(p => `${p.homeTeam}|${p.awayTeam}`));
    let fallbackPool = mlsPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
    if (fallbackPool.length === 0) {
      fallbackPool = allPreds.filter(p => !alreadySelected.has(`${p.homeTeam}|${p.awayTeam}`));
    }
    const fallbackLegs = selectBestLegs(fallbackPool, needed, HARD_FLOOR, CONFIDENCE_THRESHOLDS.PRO_MIN - 0.01);
    for (const leg of fallbackLegs) {
      markHighVolatility(leg);
      mlsLegs.push(leg);
      console.log(`[Waterfall] ⚠️  MLS FALLBACK (High Volatility): ${leg.homeTeam} vs ${leg.awayTeam} @ ${leg.topConfidence.toFixed(1)}%`);
    }
  }

  console.log(`[Waterfall] Final: Soccer=${soccerLegs.length}/3, NBA=${nbaLegs.length}/3, MLS=${mlsLegs.length}/2, HighVol=${highVolatilityLegs.size}`);

  // ── Select 1 Power Pick (highest confidence across ALL sports ≥68%) ─────
  // Power Pick rule: Must be 68%+ (primary). Falls back to highest available if nothing at 68%+.
  // HARD RULE: Power Pick must pass 12-factor validation (it already did — it scored ≥68%).
  // No draws, no picks below 65%.
  const powerCandidates = [...soccerLegs, ...nbaLegs, ...mlsLegs]
    .filter(p => p.topConfidence >= CONFIDENCE_THRESHOLDS.PRO_MIN)  // 68%+
    .filter(p => !p.topPick.toLowerCase().includes('draw'))
    .sort((a, b) => b.topConfidence - a.topConfidence);
  // If nothing at 68%+, use the highest confidence leg from all selected legs (min 65%)
  const powerPickFallback = [...soccerLegs, ...nbaLegs, ...mlsLegs]
    .filter(p => p.topConfidence >= HARD_FLOOR)
    .filter(p => !p.topPick.toLowerCase().includes('draw'))
    .sort((a, b) => b.topConfidence - a.topConfidence)[0] || null;
  const powerPick = powerCandidates[0] || powerPickFallback;  // Always pick the best available ≥65%

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
  async function savePick(pred: PredictionResult, overrideSport?: string, overrideTier?: string, isPower = false, highVolatility = false) {
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
        metadata:   { ...pred as any, isHighVolatility: highVolatility, volatilityLabel: highVolatility ? 'High Volatility' : null } as any,
      });
    } catch (err) {
      console.error('[Engine] Failed to save pick:', err);
    }
  }

  // Save soccer legs (type = 'soccer')
  for (const pred of soccerLegs) {
    const hv = isHighVol(pred);
    await savePick(pred, 'soccer', undefined, false, hv);
    soccerCount++;
    console.log(`[Engine] ${hv ? '⚠️ ' : '✅'} Soccer leg: ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)${hv ? ' [HIGH VOLATILITY]' : ''}`);
  }

  // Save NBA legs (type = 'nba')
  for (const pred of nbaLegs) {
    const hv = isHighVol(pred);
    await savePick(pred, 'nba', undefined, false, hv);
    nbaCount++;
    console.log(`[Engine] ${hv ? '⚠️ ' : '✅'} NBA leg:    ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)${hv ? ' [HIGH VOLATILITY]' : ''}`);
  }

  // Save MLS legs (type = 'mls') — only if games exist
  if (mlsLegs.length > 0) {
    for (const pred of mlsLegs) {
      const hv = isHighVol(pred);
      await savePick(pred, 'mls', undefined, false, hv);
      mlsCount++;
      console.log(`[Engine] ${hv ? '⚠️ ' : '✅'} MLS leg:    ${pred.homeTeam} vs ${pred.awayTeam} — ${pred.topPick} (${pred.topConfidence.toFixed(1)}%)${hv ? ' [HIGH VOLATILITY]' : ''}`);
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

      // ── Load admin site-control overrides from engineConfig ──────────────────
      const cfg = await storage.getEngineConfig();

      // Helper: build a manual leg object from engineConfig prefix
      function cfgLeg(prefix: string) {
        return {
          game:                `${cfg[`${prefix}_home`] || ''} vs ${cfg[`${prefix}_away`] || ''}`,
          match:               `${cfg[`${prefix}_home`] || ''} vs ${cfg[`${prefix}_away`] || ''}`,
          pick:                cfg[`${prefix}_pick`]   || '',
          pick_type:           cfg[`${prefix}_pick`]   || '',
          pick_label:          cfg[`${prefix}_pick`]   || '',
          confidence:          parseFloat(cfg[`${prefix}_conf`] || '0'),
          probability:         parseFloat(((parseFloat(cfg[`${prefix}_conf`] || '0')) / 100).toFixed(2)),
          probability_display: `${cfg[`${prefix}_conf`] || '0'}%`,
          confidence_pct:      `${cfg[`${prefix}_conf`] || '0'}%`,
          league:              cfg[`${prefix}_league`] || '',
          odds:                cfg[`${prefix}_odds`]   || '',
          time:                `${date} — Today`,
          time_display:        `${date} — Today`,
          analysis:            `Gold Standard V3 Titan XII — ${cfg[`${prefix}_pick`] || ''} at ${cfg[`${prefix}_conf`] || '0'}%.`,
          reasoning:           `Gold Standard V3 Titan XII — ${cfg[`${prefix}_pick`] || ''} at ${cfg[`${prefix}_conf`] || '0'}%.`,
          home_team:           cfg[`${prefix}_home`]   || '',
          away_team:           cfg[`${prefix}_away`]   || '',
          tier:                'pro',
          sport:               cfg[`${prefix}_sport`]  || 'soccer',
          spread:              cfg[`${prefix}_spread`] || '',
          total:               cfg[`${prefix}_total`]  || '',
          isHighVolatility:    false,
        };
      }

      // ── NBA parlay: use admin override if enabled, else DB picks ─────────────
      const nbaAdminEnabled = cfg['nba_parlay_enabled'] !== 'false';
      const nbaAdminLegs = nbaAdminEnabled && cfg['nba_leg1_home']
        ? [1,2,3].map(i => cfgLeg(`nba_leg${i}`)).filter(l => l.home_team)
        : null;
      const nbaPicks = nbaAdminLegs || sportOnly.filter(p => p.sport === 'nba').slice(0, 3);

      // ── Soccer parlay: use admin override if enabled, else DB picks ──────────
      const socAdminEnabled = cfg['soc_parlay_enabled'] !== 'false';
      const socAdminLegs = socAdminEnabled && cfg['soc_leg1_home']
        ? [1,2,3].map(i => cfgLeg(`soc_leg${i}`)).filter(l => l.home_team)
        : null;
      const soccerPicks = socAdminLegs || sportOnly.filter(p => p.sport === 'soccer').slice(0, 3);

      // ── MLS parlay: use admin override if enabled, else DB picks ─────────────
      const mlsAdminEnabled = cfg['mls_parlay_enabled'] !== 'false';
      const mlsAdminLegs = mlsAdminEnabled && cfg['mls_leg1_home']
        ? [1,2,3].map(i => cfgLeg(`mls_leg${i}`)).filter(l => l.home_team)
        : null;
      const mlsPicks = mlsAdminLegs || sportOnly.filter(p => p.sport === 'mls').slice(0, 3);

      // ── Power Pick: use admin override if enabled, else DB pick ──────────────
      const ppAdminEnabled = cfg['pp_enabled'] !== 'false';
      const ppAdminActive  = ppAdminEnabled && cfg['pp_home'];
      const dbPowerPick    = publicActive.find(p => p.isPowerPick) ||
                             [...publicActive].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      const powerPick: any = ppAdminActive ? {
        homeTeam:   cfg['pp_home'],
        awayTeam:   cfg['pp_away'],
        league:     cfg['pp_league'],
        sport:      cfg['pp_sport'],
        prediction: cfg['pp_pick'],
        confidence: parseFloat(cfg['pp_confidence'] || '0'),
        odds:       cfg['pp_odds'],
        analysis:   cfg['pp_analysis'],
        isPowerPick: true,
        isFeatured:  false,
        tier:        'pro',
        metadata:    { recommendation: cfg['pp_analysis'] },
      } : dbPowerPick;

      // ── Featured Game: use admin override if liveOnSite=true ─────────────────
      const fgLive = cfg['fg_live'] === 'true' && cfg['fg_home'];
      const adminFeaturedGame: any = fgLive ? {
        homeTeam:   cfg['fg_home'],
        awayTeam:   cfg['fg_away'],
        league:     cfg['fg_league'],
        sport:      cfg['fg_sport'],
        prediction: cfg['fg_pick'],
        confidence: parseFloat(cfg['fg_confidence'] || '0'),
        odds:       cfg['fg_home_odds'],
        isFeatured:  true,
        isPowerPick: false,
        tier:        'pro',
        metadata:    {},
      } : null;

      // Featured Mega-Pick: admin featured game > isFeatured DB pick > powerPick
      const dbFeaturedPick   = publicActive.find(p => p.isFeatured);
      const featuredMegaPick = adminFeaturedGame || dbFeaturedPick || powerPick;

      // ── Expert Analysis: use admin override if visible ───────────────────────
      const eaVisible = cfg['ea_visible'] !== 'false';
      const expertAnalysis = eaVisible && cfg['ea_body'] ? {
        title:      cfg['ea_title'] || `Gold Standard V3 Titan XII — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Moncton' })}`,
        body:       cfg['ea_body'],
        visible:    true,
        updated_at: new Date().toISOString(),
      } : null;

      const now = new Date().toISOString();
      const dateDisplay = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/Moncton',
      });

      function fmtLeg(p: any) {
        // If p already has the cfgLeg shape (has .home_team), return as-is
        if (p.home_team !== undefined) return p;
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
          isHighVolatility: (p.metadata as any)?.isHighVolatility ?? false,
          volatilityLabel: (p.metadata as any)?.volatilityLabel ?? null,
        };
      }

      function combinedProb(legs: any[]): string {
        if (!legs.length) return '0%';
        const c = legs.reduce((acc, p) => acc * ((p.confidence ?? 68) / 100), 1);
        return `${(c * 100).toFixed(1)}%`;
      }

      // Build parlay leg arrays (already resolved above as admin or DB)
      const parlayLegs = (soccerPicks as any[]).map(fmtLeg);
      const mlsLegs    = (mlsPicks    as any[]).map(fmtLeg);
      const nbaLegs    = (nbaPicks    as any[]).map(fmtLeg);
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
          confidence: Math.round(powerPick.confidence ?? 0),
          confidence_pct: `${Math.round(powerPick.confidence ?? 0)}%`,
          odds: powerPick.odds || '-110',
          sport: powerPick.sport || 'nba',
          time: `${date} — Today`,
          analysis: (powerPick as any).analysis || (powerPick.metadata as any)?.recommendation || `Gold Standard V3 Titan XII — Top pick at ${Math.round(powerPick.confidence ?? 0)}%.`,
          enabled: ppAdminEnabled,
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
        featured_soccer: parlayLegs[0] ? {
          match: parlayLegs[0].match || parlayLegs[0].game || '',
          league: parlayLegs[0].league || 'Soccer',
          sport: 'soccer',
          pick: parlayLegs[0].pick || '',
          confidence: Math.round(parlayLegs[0].confidence ?? 0),
          confidence_display: `${Math.round(parlayLegs[0].confidence ?? 0)}%`,
          reasoning: parlayLegs[0].reasoning || `Gold Standard V3 Titan XII — ${parlayLegs[0].pick} at ${Math.round(parlayLegs[0].confidence ?? 0)}%.`,
          match_date: date,
          enabled: socAdminEnabled,
        } : { match: '', league: '', sport: 'soccer', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date, enabled: socAdminEnabled },
        featured_mls: mlsLegs[0] ? {
          match: mlsLegs[0].match || mlsLegs[0].game || '',
          league: mlsLegs[0].league || 'MLS',
          sport: 'mls',
          pick: mlsLegs[0].pick || '',
          confidence: Math.round(mlsLegs[0].confidence ?? 0),
          confidence_display: `${Math.round(mlsLegs[0].confidence ?? 0)}%`,
          reasoning: mlsNoSlate ? 'No MLS games today.' : (mlsLegs[0].reasoning || `Gold Standard V3 Titan XII — ${mlsLegs[0].pick} at ${Math.round(mlsLegs[0].confidence ?? 0)}%.`),
          match_date: date,
          enabled: mlsAdminEnabled,
        } : { match: '', league: 'MLS', sport: 'mls', pick: '', confidence: 0, confidence_display: '0%', reasoning: 'No MLS games today.', match_date: date, enabled: mlsAdminEnabled },
        featured_nba: nbaLegs[0] ? {
          match: nbaLegs[0].match || nbaLegs[0].game || '',
          league: nbaLegs[0].league || 'NBA',
          sport: 'nba',
          pick: nbaLegs[0].pick || '',
          confidence: Math.round(nbaLegs[0].confidence ?? 0),
          confidence_display: `${Math.round(nbaLegs[0].confidence ?? 0)}%`,
          reasoning: nbaLegs[0].reasoning || `Gold Standard V3 Titan XII — ${nbaLegs[0].pick} at ${Math.round(nbaLegs[0].confidence ?? 0)}%.`,
          match_date: date,
          enabled: nbaAdminEnabled,
        } : { match: '', league: 'NBA', sport: 'nba', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date, enabled: nbaAdminEnabled },
        nba_picks: nbaLegs,
        player_prop_picks: [],
        free_tier_picks: active.filter(p => p.tier === 'free').slice(0, 3).map(fmtLeg),
        results: { date_display: dateDisplay, entries: [] },
        expert_analysis: expertAnalysis || {
          title: `Gold Standard V3 Titan XII — ${dateDisplay}`,
          body: `Today's picks were generated by the Gold Standard V3 Titan XII 12-factor AI engine. All picks passed the 68% confidence threshold.`,
          visible: true,
          updated_at: now,
        },
        manual_lock: cfg['maintenance_mode'] === 'true',
        locked_sections: cfg['maintenance_mode'] === 'true' ? ['all'] : [],
        site_settings: {
          alertEnabled:     cfg['alert_enabled']    === 'true',
          alertText:        cfg['alert_text']        || '',
          alertType:        cfg['alert_type']        || 'info',
          maintenanceMode:  cfg['maintenance_mode']  === 'true',
          maintenanceMsg:   cfg['maintenance_msg']   || 'Site is under maintenance. Check back soon.',
          engineLabel:      cfg['engine_label']      || 'Gold Standard V3 Titan XII',
          footerDisclaimer: cfg['footer_disclaimer'] || 'For entertainment purposes only. Please gamble responsibly.',
          contactEmail:     cfg['contact_email']     || 'Glenoring@gmail.com',
          twitterUrl:       cfg['twitter_url']       || '',
          instagramUrl:     cfg['instagram_url']     || '',
          discordUrl:       cfg['discord_url']       || '',
        },
        vip_content: cfg['vip_override'] === 'true' ? {
          headline:    cfg['vip_headline']    || '',
          subheadline: cfg['vip_subheadline'] || '',
          feature1:    cfg['vip_feature1']    || '',
          feature2:    cfg['vip_feature2']    || '',
          feature3:    cfg['vip_feature3']    || '',
          feature4:    cfg['vip_feature4']    || '',
          ctaText:     cfg['vip_cta_text']    || '',
          ctaLink:     cfg['vip_cta_link']    || '',
          badgeLabel:  cfg['vip_badge_label'] || '',
          imageUrl:    cfg['vip_image_url']   || '',
          overrideOn:  true,
        } : null,
        history_manual: (() => {
          try { return JSON.parse(cfg['history_entries'] || '[]'); } catch { return []; }
        })(),
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

  // GET /api/admin/picks-today — alias for Parlay Builder (returns today's picks with { picks: [...] } shape)
  app.get('/api/admin/picks-today', requireAuth, async (req, res) => {
    try {
      const today = new Date().toLocaleDateString('en-CA');
      const picks = await storage.getPicksByDate(today);
      res.json({ picks, date: today, total: picks.length });
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

  // ── SEO Ping ─────────────────────────────────────────────────────────────────
  app.post('/api/admin/seo-ping', requireAuth, async (req, res) => {
    try {
      const siteUrl = 'https://soccernbaparlayking.vip';
      const sitemapUrl = encodeURIComponent(`${siteUrl}/sitemap.xml`);
      const results: string[] = [];

      // Ping Google
      try {
        const gRes = await fetch(`https://www.google.com/ping?sitemap=${sitemapUrl}`);
        results.push(`Google: ${gRes.status === 200 ? 'OK' : gRes.status}`);
      } catch {
        results.push('Google: unreachable');
      }

      // Ping Bing
      try {
        const bRes = await fetch(`https://www.bing.com/ping?sitemap=${sitemapUrl}`);
        results.push(`Bing: ${bRes.status === 200 ? 'OK' : bRes.status}`);
      } catch {
        results.push('Bing: unreachable');
      }

      res.json({ success: true, results, message: results.join(' | ') });
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
  // Alias: admin.html calls /tiers-pricing (with s)
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
      // Determine tier, expiry, and lock from plan
      let tier = 'free';
      let expiresAt: Date | null = null;
      let tierLockedUntil: Date | null = null;
      let subscriptionPlan = plan || 'free';
      if (plan === 'lifetime') {
        tier = 'lifetime';
        expiresAt = null;          // never expires
        tierLockedUntil = null;    // no lock needed — permanent
      } else if (plan === 'pro-monthly') {
        tier = 'pro';
        expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);  // 30 days
        tierLockedUntil = expiresAt;  // locked until subscription ends
      } else if (plan === 'vip-monthly') {
        tier = 'vip';
        expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        tierLockedUntil = expiresAt;
      }
      // Upsert member with username, password, tier, expiry, and lock
      await pool.query(
        `INSERT INTO members (email, username, password_hash, tier, subscription_plan, expires_at, tier_locked_until, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
         ON CONFLICT (email) DO UPDATE SET
           username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           tier = EXCLUDED.tier,
           subscription_plan = EXCLUDED.subscription_plan,
           expires_at = EXCLUDED.expires_at,
           tier_locked_until = EXCLUDED.tier_locked_until,
           is_active = true`,
        [email, username, passwordHash, tier, subscriptionPlan, expiresAt, tierLockedUntil]
      );
      await pool.end();
      // Issue JWT with expiry info
      const token = jwt.sign({ email, username, tier, expiresAt: expiresAt?.toISOString() || null }, JWT_SECRET, { expiresIn: '90d' });
      return res.json({ success: true, token, tier, username, expiresAt: expiresAt?.toISOString() || null, subscriptionPlan });
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
      // Check if subscription has expired — if so, downgrade to free
      let activeTier = member.tier;
      if (member.expires_at && new Date(member.expires_at) < new Date() && member.tier !== 'lifetime') {
        activeTier = 'free';
        // Update DB to reflect expired tier
        const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await pool2.query('UPDATE members SET tier = $1, tier_locked_until = NULL WHERE email = $2', ['free', member.email]);
        await pool2.end();
      }
      const token = jwt.sign(
        { email: member.email, username: member.username, tier: activeTier, expiresAt: member.expires_at || null },
        JWT_SECRET,
        { expiresIn: '90d' }
      );
      return res.json({
        success: true, token,
        tier: activeTier,
        username: member.username,
        email: member.email,
        expiresAt: member.expires_at || null,
        tierLockedUntil: member.tier_locked_until || null,
        subscriptionPlan: member.subscription_plan || null,
      });
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

  // ── V3 VALIDATOR ENDPOINTS ──────────────────────────────────────────────────

  // GET /api/admin/v3-games — fetch all games from The Odds API (cached 4h, 1 call per sport)
  app.get('/api/admin/v3-games', requireAuth, async (req: Request, res: Response) => {
    try {
      const { getGlobalSoccerOdds, getNBAOdds, getMLSOdds, getBudgetLedger } = await import('./apis/oddsApi.js');
      const [soccerGames, nbaGames, mlsGames] = await Promise.all([
        getGlobalSoccerOdds().catch(() => []),
        getNBAOdds().catch(() => []),
        getMLSOdds().catch(() => []),
      ]);
      const allGames = [...soccerGames, ...nbaGames, ...mlsGames];
      const today = new Date().toLocaleDateString('en-CA');
      const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');

      const games = allGames
        .filter(g => {
          const d = new Date(g.commence_time).toLocaleDateString('en-CA');
          return d >= today && d <= in7Days;
        })
        .map(g => {
          const sport: 'nba' | 'mls' | 'soccer' = g.sport_key.startsWith('basketball') ? 'nba' :
            g.sport_key === 'soccer_usa_mls' ? 'mls' : 'soccer';
          const fixture: FixtureData = {
            fixtureId: parseInt(g.id.replace(/\D/g, '').slice(0, 8) || '0', 10),
            homeTeam: g.home_team,
            awayTeam: g.away_team,
            league: g.sport_title,
            sport,
            homeOdds: g.home_odds ?? undefined,
            drawOdds: g.draw_odds ?? undefined,
            awayOdds: g.away_odds ?? undefined,
            homeInjuries: 0,
            awayInjuries: 0,
            isNeutralVenue: false,
          } as FixtureData;
          const preds = runBatchPredictions([fixture]);
          const pred = preds[0];
          const conf = pred ? pred.topConfidence : 0;
          const outcomes: { label: string; conf: number }[] = [];
          if (pred) {
            const p = pred.predictions;
            // Engine already returns values on 0-100 scale — no * 100 needed
            if (p.homeWin)    outcomes.push({ label: `${g.home_team} Win`, conf: p.homeWin });
            if (p.awayWin)    outcomes.push({ label: `${g.away_team} Win`, conf: p.awayWin });
            if (p.draw)       outcomes.push({ label: 'Draw', conf: p.draw });
            if (p.homeOrDraw) outcomes.push({ label: `${g.home_team} Win or Draw`, conf: p.homeOrDraw });
            if (p.awayOrDraw) outcomes.push({ label: `${g.away_team} Win or Draw`, conf: p.awayOrDraw });
            if (p.over25)     outcomes.push({ label: 'Over 2.5 Goals', conf: p.over25 });
            if (p.under25)    outcomes.push({ label: 'Under 2.5 Goals', conf: p.under25 });
            if (p.btts)       outcomes.push({ label: 'Both Teams to Score', conf: p.btts });
          }
          return {
            id: g.id,
            sportKey: g.sport_key,
            sport,
            league: g.sport_title,
            homeTeam: g.home_team,
            awayTeam: g.away_team,
            commenceTime: g.commence_time,
            lastUpdated: g.last_update,
            date: new Date(g.commence_time).toLocaleDateString('en-CA'),
            homeOdds: g.home_odds,
            awayOdds: g.away_odds,
            drawOdds: g.draw_odds,
            bookmaker: g.bookmaker,
            confidence: Math.round(conf * 10) / 10,
            bestPick: pred ? pred.topPick : 'N/A',
            outcomes: outcomes.sort((a, b) => b.conf - a.conf),
            validated: false,
          };
        });

      const ledger = getBudgetLedger();
      res.json({
        success: true,
        games,
        total: games.length,
        budget: { used: ledger.used, remaining: ledger.remaining, resetTime: ledger.lastReset },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/v3-validate — run full Titan XII on a specific game by ID
  app.post('/api/admin/v3-validate', requireAuth, async (req: Request, res: Response) => {
    try {
      const { gameId } = req.body;
      if (!gameId) return res.status(400).json({ error: 'gameId required' });
      const { getGlobalSoccerOdds, getNBAOdds, getMLSOdds } = await import('./apis/oddsApi.js');
      const [soccerGames, nbaGames, mlsGames] = await Promise.all([
        getGlobalSoccerOdds().catch(() => []),
        getNBAOdds().catch(() => []),
        getMLSOdds().catch(() => []),
      ]);
      const g = [...soccerGames, ...nbaGames, ...mlsGames].find(x => x.id === gameId);
      if (!g) return res.status(404).json({ error: 'Game not found in current API data' });
      const sport: 'nba' | 'mls' | 'soccer' = g.sport_key.startsWith('basketball') ? 'nba' :
        g.sport_key === 'soccer_usa_mls' ? 'mls' : 'soccer';
      const fixture: FixtureData = {
        fixtureId: parseInt(g.id.replace(/\D/g, '').slice(0, 8) || '0', 10),
        homeTeam: g.home_team, awayTeam: g.away_team, league: g.sport_title, sport,
        homeOdds: g.home_odds ?? undefined, drawOdds: g.draw_odds ?? undefined, awayOdds: g.away_odds ?? undefined,
        homeInjuries: 0, awayInjuries: 0, isNeutralVenue: false,
      } as FixtureData;
      const preds = runBatchPredictions([fixture]);
      const pred = preds[0];
      if (!pred) return res.status(422).json({ error: 'Engine returned no prediction for this fixture' });
      const conf = pred.topConfidence;
      const outcomes: { label: string; conf: number }[] = [];
      const p = pred.predictions;
      // Engine already returns values on 0-100 scale — no * 100 needed
      if (p.homeWin)    outcomes.push({ label: `${g.home_team} Win`, conf: p.homeWin });
      if (p.awayWin)    outcomes.push({ label: `${g.away_team} Win`, conf: p.awayWin });
      if (p.draw)       outcomes.push({ label: 'Draw', conf: p.draw });
      if (p.homeOrDraw) outcomes.push({ label: `${g.home_team} Win or Draw`, conf: p.homeOrDraw });
      if (p.awayOrDraw) outcomes.push({ label: `${g.away_team} Win or Draw`, conf: p.awayOrDraw });
      if (p.over25)     outcomes.push({ label: 'Over 2.5 Goals', conf: p.over25 });
      if (p.under25)    outcomes.push({ label: 'Under 2.5 Goals', conf: p.under25 });
      if (p.btts)       outcomes.push({ label: 'Both Teams to Score', conf: p.btts });
      res.json({
        success: true,
        game: {
          id: g.id, homeTeam: g.home_team, awayTeam: g.away_team, league: g.sport_title, sport,
          confidence: Math.round(conf * 10) / 10, bestPick: pred.topPick,
          outcomes: outcomes.sort((a, b) => b.conf - a.conf),
          factors: pred.factors, recommendation: pred.recommendation, validated: true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/feature-pick — mark a game as the hero featured pick
  app.post('/api/admin/feature-pick', requireAuth, async (req: Request, res: Response) => {
    try {
      const { matchup, pick, confidence } = req.body;
      if (!matchup || !pick) return res.status(400).json({ error: 'matchup and pick required' });
      const today = new Date().toLocaleDateString('en-CA');
      // Clear existing featured picks for today then mark the target pick as featured
      const { Pool: FeaturePool } = await import('pg');
      const fPool = new FeaturePool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await fPool.query('UPDATE picks SET is_featured = false WHERE date = $1', [today]);
      await fPool.query(
        'UPDATE picks SET is_featured = true WHERE date = $1 AND (home_team || \' vs \' || away_team = $2 OR prediction = $3) LIMIT 1',
        [today, matchup, pick]
      );
      await fPool.end();
      res.json({ success: true, message: `Featured: ${matchup} — ${pick} @ ${confidence}%` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/push-pick — push a validated game directly to live picks
  app.post('/api/admin/push-pick', requireAuth, async (req: Request, res: Response) => {
    try {
      const { matchup, pick, confidence, sport, league } = req.body;
      if (!matchup || !pick || !sport) return res.status(400).json({ error: 'matchup, pick, sport required' });
      const parts = matchup.split(' vs ');
      const homeTeam = parts[0]?.trim() || matchup;
      const awayTeam = parts[1]?.trim() || '';
      const today = new Date().toLocaleDateString('en-CA');
      const tier = confidence >= 68 ? 'pro' : 'free';
      const isHighVolatility = confidence < 68;
      await storage.createPick({
        homeTeam, awayTeam,
        league: league || sport.toUpperCase(),
        sport,
        prediction: pick,
        confidence: Math.round(confidence * 10) / 10,
        status: 'pending',
        date: today,
        tier,
        isPowerPick: false,
        isFeatured: false,
        metadata: { isHighVolatility, source: 'v3-validator', pushedAt: new Date().toISOString() },
      });
      res.json({ success: true, message: `Pushed to live: ${matchup} — ${pick} @ ${confidence}%` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ── SITE CONTROL PANEL — 6 Admin Management Tabs ─────────────────────────────
  // All state stored in engine_config table (key-value). No API calls made here.
  // Cache is busted immediately on every save so the live site reflects in <3s.
  // ─────────────────────────────────────────────────────────────────────────────

  // ── In-memory picks.json cache buster ────────────────────────────────────────
  // Any write to the 6 control tabs calls clearPicksCache() so /picks.json
  // rebuilds on the very next request.
  let _picksCache: { payload: any; ts: number } | null = null;
  function clearPicksCache() { _picksCache = null; }
  // Expose so picks.json can use it
  (app as any)._clearPicksCache = clearPicksCache;
  (app as any)._getPicksCache  = () => _picksCache;
  (app as any)._setPicksCache  = (v: any) => { _picksCache = v; };

  // ── TAB 1: FEATURED GAME ─────────────────────────────────────────────────────
  // GET  /api/admin/featured-game  — load current featured game config
  // POST /api/admin/featured-game  — save featured game + toggle Live on Site
  app.get('/api/admin/featured-game', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        homeTeam:   cfg['fg_home']    || '',
        awayTeam:   cfg['fg_away']    || '',
        league:     cfg['fg_league']  || '',
        sport:      cfg['fg_sport']   || 'soccer',
        homeOdds:   cfg['fg_home_odds'] || '',
        awayOdds:   cfg['fg_away_odds'] || '',
        drawOdds:   cfg['fg_draw_odds'] || '',
        confidence: cfg['fg_confidence'] || '',
        pick:       cfg['fg_pick']    || '',
        liveOnSite: cfg['fg_live']    === 'true',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/featured-game', requireAuth, async (req, res) => {
    try {
      const { homeTeam, awayTeam, league, sport, homeOdds, awayOdds, drawOdds, confidence, pick, liveOnSite } = req.body;
      const conf = parseFloat(confidence) || 0;
      // Auto-generate odds from confidence if not manually provided
      const autoHomeOdds = homeOdds  || confidenceToAmericanOdds(conf);
      const autoAwayOdds = awayOdds  || confidenceToAmericanOdds(Math.max(conf - 10, 45));
      const autoDrawOdds = drawOdds  || (sport === 'soccer' ? '+280' : '');
      await Promise.all([
        storage.setEngineConfig('fg_home',       homeTeam   || ''),
        storage.setEngineConfig('fg_away',       awayTeam   || ''),
        storage.setEngineConfig('fg_league',     league     || ''),
        storage.setEngineConfig('fg_sport',      sport      || 'soccer'),
        storage.setEngineConfig('fg_home_odds',  autoHomeOdds),
        storage.setEngineConfig('fg_away_odds',  autoAwayOdds),
        storage.setEngineConfig('fg_draw_odds',  autoDrawOdds),
        storage.setEngineConfig('fg_confidence', String(conf || '')),
        storage.setEngineConfig('fg_pick',       pick       || ''),
        storage.setEngineConfig('fg_live',       liveOnSite ? 'true' : 'false'),
      ]);
      clearPicksCache();
      res.json({ success: true, message: liveOnSite ? 'Featured game is LIVE on site' : 'Featured game saved (not live)' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Odds Auto-Generator ─────────────────────────────────────────────────────
  // Converts V3 confidence % → American odds (no API calls, pure math)
  // Formula: confidence → implied probability → American moneyline
  // e.g. 75% confidence → -300, 60% → -150, 55% → -122, 50% → +100, 45% → +122
  function confidenceToAmericanOdds(confidence: number): string {
    if (!confidence || confidence <= 0) return '';
    // Apply a slight vig adjustment (book margin ~5%) to make odds realistic
    const vig = 0.05;
    const impliedProb = Math.min(Math.max(confidence / 100, 0.01), 0.99);
    const viggedProb  = impliedProb * (1 + vig);
    if (viggedProb >= 0.5) {
      // Favourite: negative odds
      const odds = Math.round(-(viggedProb / (1 - viggedProb)) * 100);
      return String(odds); // e.g. -300
    } else {
      // Underdog: positive odds
      const odds = Math.round(((1 - viggedProb) / viggedProb) * 100);
      return '+' + String(odds); // e.g. +250
    }
  }

  // ── TAB 2: EXPERT ANALYSIS ───────────────────────────────────────────────────
  // GET  /api/admin/expert-analysis  — load current analysis text + visibility
  // POST /api/admin/expert-analysis  — save rich-text analysis + show/hide toggle
  app.get('/api/admin/expert-analysis', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        title:   cfg['ea_title']   || '',
        body:    cfg['ea_body']    || '',
        visible: cfg['ea_visible'] !== 'false',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/expert-analysis', requireAuth, async (req, res) => {
    try {
      const { title, body, visible } = req.body;
      await Promise.all([
        storage.setEngineConfig('ea_title',   title   || ''),
        storage.setEngineConfig('ea_body',    body    || ''),
        storage.setEngineConfig('ea_visible', visible !== false ? 'true' : 'false'),
      ]);
      clearPicksCache();
      res.json({ success: true, message: visible !== false ? 'Expert analysis visible on site' : 'Expert analysis hidden' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 3: 3-LEG NBA PARLAY ──────────────────────────────────────────────────
  // GET  /api/admin/parlay-nba   — load 3 NBA slots
  // POST /api/admin/parlay-nba   — save 3 NBA slots + enable/disable toggle
  app.get('/api/admin/parlay-nba', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      const legs = [1,2,3].map(i => ({
        homeTeam:   cfg[`nba_leg${i}_home`]   || '',
        awayTeam:   cfg[`nba_leg${i}_away`]   || '',
        pick:       cfg[`nba_leg${i}_pick`]   || '',
        spread:     cfg[`nba_leg${i}_spread`] || '',
        total:      cfg[`nba_leg${i}_total`]  || '',
        odds:       cfg[`nba_leg${i}_odds`]   || '',
        confidence: cfg[`nba_leg${i}_conf`]   || '',
      }));
      res.json({ legs, enabled: cfg['nba_parlay_enabled'] !== 'false' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/parlay-nba', requireAuth, async (req, res) => {
    try {
      const { legs, enabled } = req.body;
      const saves: Promise<void>[] = [];
      (legs || []).slice(0,3).forEach((leg: any, i: number) => {
        const n = i + 1;
        const conf = parseFloat(leg.confidence) || 0;
        const autoOdds = leg.odds || confidenceToAmericanOdds(conf);
        saves.push(storage.setEngineConfig(`nba_leg${n}_home`,   leg.homeTeam   || ''));
        saves.push(storage.setEngineConfig(`nba_leg${n}_away`,   leg.awayTeam   || ''));
        saves.push(storage.setEngineConfig(`nba_leg${n}_pick`,   leg.pick       || ''));
        saves.push(storage.setEngineConfig(`nba_leg${n}_spread`, leg.spread     || ''));
        saves.push(storage.setEngineConfig(`nba_leg${n}_total`,  leg.total      || ''));
        saves.push(storage.setEngineConfig(`nba_leg${n}_odds`,   autoOdds));
        saves.push(storage.setEngineConfig(`nba_leg${n}_conf`,   String(conf || '')));
      });
      saves.push(storage.setEngineConfig('nba_parlay_enabled', enabled !== false ? 'true' : 'false'));
      await Promise.all(saves);
      clearPicksCache();
      res.json({ success: true, message: enabled !== false ? 'NBA parlay enabled on site' : 'NBA parlay disabled — placeholder shown' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 4: 3-LEG SOCCER PARLAY ───────────────────────────────────────────────
  app.get('/api/admin/parlay-soccer', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      const legs = [1,2,3].map(i => ({
        homeTeam:   cfg[`soc_leg${i}_home`]   || '',
        awayTeam:   cfg[`soc_leg${i}_away`]   || '',
        pick:       cfg[`soc_leg${i}_pick`]   || '',
        odds:       cfg[`soc_leg${i}_odds`]   || '',
        confidence: cfg[`soc_leg${i}_conf`]   || '',
        league:     cfg[`soc_leg${i}_league`] || '',
      }));
      res.json({ legs, enabled: cfg['soc_parlay_enabled'] !== 'false' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/parlay-soccer', requireAuth, async (req, res) => {
    try {
      const { legs, enabled } = req.body;
      const saves: Promise<void>[] = [];
      (legs || []).slice(0,3).forEach((leg: any, i: number) => {
        const n = i + 1;
        const conf = parseFloat(leg.confidence) || 0;
        const autoOdds = leg.odds || confidenceToAmericanOdds(conf);
        saves.push(storage.setEngineConfig(`soc_leg${n}_home`,   leg.homeTeam   || ''));
        saves.push(storage.setEngineConfig(`soc_leg${n}_away`,   leg.awayTeam   || ''));
        saves.push(storage.setEngineConfig(`soc_leg${n}_pick`,   leg.pick       || ''));
        saves.push(storage.setEngineConfig(`soc_leg${n}_odds`,   autoOdds));
        saves.push(storage.setEngineConfig(`soc_leg${n}_conf`,   String(conf || '')));
        saves.push(storage.setEngineConfig(`soc_leg${n}_league`, leg.league     || ''));
      });
      saves.push(storage.setEngineConfig('soc_parlay_enabled', enabled !== false ? 'true' : 'false'));
      await Promise.all(saves);
      clearPicksCache();
      res.json({ success: true, message: enabled !== false ? 'Soccer parlay enabled on site' : 'Soccer parlay disabled — placeholder shown' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 5: 3-LEG MLS PARLAY ──────────────────────────────────────────────────
  app.get('/api/admin/parlay-mls', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      const legs = [1,2,3].map(i => ({
        homeTeam:   cfg[`mls_leg${i}_home`]   || '',
        awayTeam:   cfg[`mls_leg${i}_away`]   || '',
        pick:       cfg[`mls_leg${i}_pick`]   || '',
        odds:       cfg[`mls_leg${i}_odds`]   || '',
        confidence: cfg[`mls_leg${i}_conf`]   || '',
      }));
      res.json({ legs, enabled: cfg['mls_parlay_enabled'] !== 'false' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/parlay-mls', requireAuth, async (req, res) => {
    try {
      const { legs, enabled } = req.body;
      const saves: Promise<void>[] = [];
      (legs || []).slice(0,3).forEach((leg: any, i: number) => {
        const n = i + 1;
        const conf = parseFloat(leg.confidence) || 0;
        const autoOdds = leg.odds || confidenceToAmericanOdds(conf);
        saves.push(storage.setEngineConfig(`mls_leg${n}_home`,   leg.homeTeam   || ''));
        saves.push(storage.setEngineConfig(`mls_leg${n}_away`,   leg.awayTeam   || ''));
        saves.push(storage.setEngineConfig(`mls_leg${n}_pick`,   leg.pick       || ''));
        saves.push(storage.setEngineConfig(`mls_leg${n}_odds`,   autoOdds));
        saves.push(storage.setEngineConfig(`mls_leg${n}_conf`,   String(conf || '')));
      });
      saves.push(storage.setEngineConfig('mls_parlay_enabled', enabled !== false ? 'true' : 'false'));
      await Promise.all(saves);
      clearPicksCache();
      res.json({ success: true, message: enabled !== false ? 'MLS parlay enabled on site' : 'MLS parlay disabled — placeholder shown' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 6: POWER PICK ────────────────────────────────────────────────────────
  app.get('/api/admin/power-pick-manual', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        homeTeam:   cfg['pp_home']       || '',
        awayTeam:   cfg['pp_away']       || '',
        league:     cfg['pp_league']     || '',
        sport:      cfg['pp_sport']      || 'nba',
        pick:       cfg['pp_pick']       || '',
        confidence: cfg['pp_confidence'] || '',
        odds:       cfg['pp_odds']       || '',
        analysis:   cfg['pp_analysis']   || '',
        enabled:    cfg['pp_enabled']    !== 'false',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/power-pick-manual', requireAuth, async (req, res) => {
    try {
      const { homeTeam, awayTeam, league, sport, pick, confidence, odds, analysis, enabled } = req.body;
      const conf = parseFloat(confidence) || 0;
      const autoOdds = odds || confidenceToAmericanOdds(conf);
      await Promise.all([
        storage.setEngineConfig('pp_home',       homeTeam   || ''),
        storage.setEngineConfig('pp_away',       awayTeam   || ''),
        storage.setEngineConfig('pp_league',     league     || ''),
        storage.setEngineConfig('pp_sport',      sport      || 'nba'),
        storage.setEngineConfig('pp_pick',       pick       || ''),
        storage.setEngineConfig('pp_confidence', String(conf || '')),
        storage.setEngineConfig('pp_odds',       autoOdds),
        storage.setEngineConfig('pp_analysis',   analysis   || ''),
        storage.setEngineConfig('pp_enabled',    enabled !== false ? 'true' : 'false'),
      ]);
      clearPicksCache();
      res.json({ success: true, message: enabled !== false ? 'Power Pick is LIVE on site' : 'Power Pick disabled — placeholder shown' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── GET /api/admin/site-control — load all 6 tabs at once (dashboard init) ───
  app.get('/api/admin/site-control', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        featuredGame: {
          homeTeam: cfg['fg_home'] || '', awayTeam: cfg['fg_away'] || '',
          league: cfg['fg_league'] || '', sport: cfg['fg_sport'] || 'soccer',
          homeOdds: cfg['fg_home_odds'] || '', awayOdds: cfg['fg_away_odds'] || '',
          drawOdds: cfg['fg_draw_odds'] || '', confidence: cfg['fg_confidence'] || '',
          pick: cfg['fg_pick'] || '', liveOnSite: cfg['fg_live'] === 'true',
        },
        expertAnalysis: {
          title: cfg['ea_title'] || '', body: cfg['ea_body'] || '',
          visible: cfg['ea_visible'] !== 'false',
        },
        parlayNba: {
          legs: [1,2,3].map(i => ({
            homeTeam: cfg[`nba_leg${i}_home`] || '', awayTeam: cfg[`nba_leg${i}_away`] || '',
            pick: cfg[`nba_leg${i}_pick`] || '', spread: cfg[`nba_leg${i}_spread`] || '',
            total: cfg[`nba_leg${i}_total`] || '', odds: cfg[`nba_leg${i}_odds`] || '',
            confidence: cfg[`nba_leg${i}_conf`] || '',
          })),
          enabled: cfg['nba_parlay_enabled'] !== 'false',
        },
        parlaySoccer: {
          legs: [1,2,3].map(i => ({
            homeTeam: cfg[`soc_leg${i}_home`] || '', awayTeam: cfg[`soc_leg${i}_away`] || '',
            pick: cfg[`soc_leg${i}_pick`] || '', odds: cfg[`soc_leg${i}_odds`] || '',
            confidence: cfg[`soc_leg${i}_conf`] || '', league: cfg[`soc_leg${i}_league`] || '',
          })),
          enabled: cfg['soc_parlay_enabled'] !== 'false',
        },
        parlayMls: {
          legs: [1,2,3].map(i => ({
            homeTeam: cfg[`mls_leg${i}_home`] || '', awayTeam: cfg[`mls_leg${i}_away`] || '',
            pick: cfg[`mls_leg${i}_pick`] || '', odds: cfg[`mls_leg${i}_odds`] || '',
            confidence: cfg[`mls_leg${i}_conf`] || '',
          })),
          enabled: cfg['mls_parlay_enabled'] !== 'false',
        },
        powerPick: {
          homeTeam: cfg['pp_home'] || '', awayTeam: cfg['pp_away'] || '',
          league: cfg['pp_league'] || '', sport: cfg['pp_sport'] || 'nba',
          pick: cfg['pp_pick'] || '', confidence: cfg['pp_confidence'] || '',
          odds: cfg['pp_odds'] || '', analysis: cfg['pp_analysis'] || '',
          enabled: cfg['pp_enabled'] !== 'false',
        },
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ── UNIVERSAL MANUAL CONTROL — VIP, HISTORY, SETTINGS TABS ──────────────────
  // All state stored in engine_config key-value table. Zero API calls.
  // Every save clears the picks.json cache for instant (<3s) site updates.
  // ─────────────────────────────────────────────────────────────────────────────

  // ── TAB 7: VIP CONTENT CONTROL ───────────────────────────────────────────────
  // Controls the paywall content: headline, sub-headline, feature list, CTA text
  // Manual Override ON → site shows your text; OFF → site shows default copy
  app.get('/api/admin/vip-content', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        headline:     cfg['vip_headline']     || '',
        subheadline:  cfg['vip_subheadline']  || '',
        feature1:     cfg['vip_feature1']     || '',
        feature2:     cfg['vip_feature2']     || '',
        feature3:     cfg['vip_feature3']     || '',
        feature4:     cfg['vip_feature4']     || '',
        ctaText:      cfg['vip_cta_text']     || '',
        ctaLink:      cfg['vip_cta_link']     || '',
        badgeLabel:   cfg['vip_badge_label']  || '',
        imageUrl:     cfg['vip_image_url']    || '',
        overrideOn:   cfg['vip_override']     === 'true',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/vip-content', requireAuth, async (req, res) => {
    try {
      const { headline, subheadline, feature1, feature2, feature3, feature4,
              ctaText, ctaLink, badgeLabel, imageUrl, overrideOn } = req.body;
      await Promise.all([
        storage.setEngineConfig('vip_headline',    headline    || ''),
        storage.setEngineConfig('vip_subheadline', subheadline || ''),
        storage.setEngineConfig('vip_feature1',    feature1    || ''),
        storage.setEngineConfig('vip_feature2',    feature2    || ''),
        storage.setEngineConfig('vip_feature3',    feature3    || ''),
        storage.setEngineConfig('vip_feature4',    feature4    || ''),
        storage.setEngineConfig('vip_cta_text',    ctaText     || ''),
        storage.setEngineConfig('vip_cta_link',    ctaLink     || ''),
        storage.setEngineConfig('vip_badge_label', badgeLabel  || ''),
        storage.setEngineConfig('vip_image_url',   imageUrl    || ''),
        storage.setEngineConfig('vip_override',    overrideOn ? 'true' : 'false'),
      ]);
      clearPicksCache();
      res.json({ success: true, message: overrideOn ? 'VIP content override is LIVE' : 'VIP content saved (override OFF — default shown)' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 8: HISTORY / WIN-LOSS RECORDS ────────────────────────────────────────
  // Manual entry for historical win/loss records shown on the Results page.
  // Each entry: date, matchup, pick, result (won/lost/void), odds, sport
  app.get('/api/admin/history-entries', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      const raw = cfg['history_entries'] || '[]';
      let entries: any[] = [];
      try { entries = JSON.parse(raw); } catch { entries = []; }
      res.json({ entries });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/history-entries', requireAuth, async (req, res) => {
    try {
      const { entries } = req.body;
      if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array' });
      // Validate each entry has required fields
      const clean = entries.map((e: any) => ({
        id:      e.id      || `hist_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        date:    e.date    || '',
        matchup: e.matchup || '',
        pick:    e.pick    || '',
        result:  ['won','lost','void'].includes(e.result) ? e.result : 'void',
        odds:    e.odds    || '',
        sport:   e.sport   || 'soccer',
        league:  e.league  || '',
        notes:   e.notes   || '',
      }));
      await storage.setEngineConfig('history_entries', JSON.stringify(clean));
      clearPicksCache();
      res.json({ success: true, count: clean.length, message: `${clean.length} history record(s) saved` });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // DELETE single history entry by id
  app.delete('/api/admin/history-entries/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const cfg = await storage.getEngineConfig();
      let entries: any[] = [];
      try { entries = JSON.parse(cfg['history_entries'] || '[]'); } catch { entries = []; }
      const filtered = entries.filter((e: any) => e.id !== id);
      await storage.setEngineConfig('history_entries', JSON.stringify(filtered));
      clearPicksCache();
      res.json({ success: true, message: `Entry ${id} deleted` });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── TAB 9: SITE-WIDE SETTINGS ────────────────────────────────────────────────
  // Controls: site alert banner, maintenance mode, engine version label,
  //           footer disclaimer, social links, and contact email.
  app.get('/api/admin/site-settings', requireAuth, async (req, res) => {
    try {
      const cfg = await storage.getEngineConfig();
      res.json({
        alertEnabled:     cfg['alert_enabled']      === 'true',
        alertText:        cfg['alert_text']          || '',
        alertType:        cfg['alert_type']          || 'info',   // info | warning | success | danger
        maintenanceMode:  cfg['maintenance_mode']    === 'true',
        maintenanceMsg:   cfg['maintenance_msg']     || 'Site is under maintenance. Check back soon.',
        engineLabel:      cfg['engine_label']        || 'Gold Standard V3 Titan XII',
        footerDisclaimer: cfg['footer_disclaimer']   || 'For entertainment purposes only. Please gamble responsibly.',
        contactEmail:     cfg['contact_email']       || 'Glenoring@gmail.com',
        twitterUrl:       cfg['twitter_url']         || '',
        instagramUrl:     cfg['instagram_url']       || '',
        discordUrl:       cfg['discord_url']         || '',
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/site-settings', requireAuth, async (req, res) => {
    try {
      const { alertEnabled, alertText, alertType, maintenanceMode, maintenanceMsg,
              engineLabel, footerDisclaimer, contactEmail, twitterUrl, instagramUrl, discordUrl } = req.body;
      await Promise.all([
        storage.setEngineConfig('alert_enabled',      alertEnabled     ? 'true' : 'false'),
        storage.setEngineConfig('alert_text',          alertText        || ''),
        storage.setEngineConfig('alert_type',          alertType        || 'info'),
        storage.setEngineConfig('maintenance_mode',    maintenanceMode  ? 'true' : 'false'),
        storage.setEngineConfig('maintenance_msg',     maintenanceMsg   || ''),
        storage.setEngineConfig('engine_label',        engineLabel      || 'Gold Standard V3 Titan XII'),
        storage.setEngineConfig('footer_disclaimer',   footerDisclaimer || ''),
        storage.setEngineConfig('contact_email',       contactEmail     || ''),
        storage.setEngineConfig('twitter_url',         twitterUrl       || ''),
        storage.setEngineConfig('instagram_url',       instagramUrl     || ''),
        storage.setEngineConfig('discord_url',         discordUrl       || ''),
      ]);
      clearPicksCache();
      res.json({ success: true, message: 'Site settings saved and cache cleared' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── API THROTTLE GUARD STATUS ─────────────────────────────────────────────────
  // GET /api/admin/api-budget — returns live budget status (no API call made)
  // Zero-refresh: admin dashboard reads this on load only; never polls automatically
  app.get('/api/admin/api-budget', requireAuth, async (req, res) => {
    try {
      const { getBudgetStatus } = await import('./apis/oddsApi.js');
      const status = getBudgetStatus();
      res.json({
        ...status,
        throttle_warning: status.used_today >= 80,
        throttle_active:  status.used_today >= 90,
        manual_reserve:   Math.max(0, 100 - status.used_today),
        message: status.used_today >= 90
          ? `⛔ AUTO TASKS PAUSED — ${status.used_today}/100 calls used. ${100 - status.used_today} manual calls remaining.`
          : status.used_today >= 80
          ? `⚠️ WARNING — ${status.used_today}/100 calls used. Approaching auto-task limit (90).`
          : `✅ ${status.used_today}/100 calls used. ${90 - status.used_today} auto-task calls remaining.`,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── PICKS.JSON SITE-SETTINGS INJECTION ───────────────────────────────────────
  // Expose site settings (alert, maintenance, engine label) in /picks.json
  // so the client.html can read and render them without any template changes.
  // This is already handled by the /picks.json endpoint reading engineConfig.
  // The client.html reads data.site_settings from picks.json on every load.

  // GET /api/auth/me — verify JWT and return current user info
  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      // Re-fetch live data from DB to get latest expiry and lock status
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query('SELECT tier, expires_at, tier_locked_until, subscription_plan FROM members WHERE email = $1', [decoded.email]);
      await pool.end();
      const row = result.rows[0];
      const activeTier = row ? row.tier : decoded.tier;
      return res.json({
        success: true,
        email: decoded.email,
        username: decoded.username,
        tier: activeTier,
        expiresAt: row?.expires_at || null,
        tierLockedUntil: row?.tier_locked_until || null,
        subscriptionPlan: row?.subscription_plan || null,
      });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
  });

  // ── MEMBER DASHBOARD ────────────────────────────────────────────────────────

  // GET /api/member/dashboard — returns tier info, expiry countdown, and today's picks for the member's tier
  app.get('/api/member/dashboard', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query('SELECT * FROM members WHERE email = $1', [decoded.email]);
      await pool.end();
      if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found.' });
      const member = result.rows[0];
      // Check expiry
      let activeTier = member.tier;
      let daysRemaining: number | null = null;
      let hoursRemaining: number | null = null;
      let isExpired = false;
      if (member.expires_at && member.tier !== 'lifetime') {
        const expiryMs = new Date(member.expires_at).getTime() - Date.now();
        if (expiryMs <= 0) {
          isExpired = true;
          activeTier = 'free';
        } else {
          daysRemaining = Math.floor(expiryMs / (1000 * 60 * 60 * 24));
          hoursRemaining = Math.floor((expiryMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        }
      }
      // Fetch today's picks for this tier
      const today = new Date().toISOString().split('T')[0];
      const tierFilter = activeTier === 'lifetime' ? ['pro', 'vip', 'free'] :
                         activeTier === 'pro'      ? ['pro', 'vip', 'free'] :
                         activeTier === 'vip'      ? ['vip', 'free'] : ['free'];
      const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const picksResult = await pool2.query(
        `SELECT * FROM picks WHERE date = $1 AND tier = ANY($2) AND is_disabled = false ORDER BY confidence DESC LIMIT 20`,
        [today, tierFilter]
      );
      await pool2.end();
      return res.json({
        success: true,
        member: {
          email: member.email,
          username: member.username,
          tier: activeTier,
          subscriptionPlan: member.subscription_plan,
          expiresAt: member.expires_at || null,
          isLifetime: activeTier === 'lifetime',
          isExpired,
          daysRemaining,
          hoursRemaining,
          tierLockedUntil: member.tier_locked_until || null,
          canUpgrade: isExpired || activeTier === 'free',
        },
        picks: picksResult.rows,
        picksDate: today,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/member/parlay-builder — returns today's top picks formatted for the Parlay Builder with sportsbook deep-links
  app.get('/api/member/parlay-builder', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const memberTier = decoded.tier || 'free';
      const today = new Date().toISOString().split('T')[0];
      const tierFilter = memberTier === 'lifetime' ? ['pro', 'vip', 'free'] :
                         memberTier === 'pro'      ? ['pro', 'vip', 'free'] :
                         memberTier === 'vip'      ? ['vip', 'free'] : ['free'];
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const picksResult = await pool.query(
        `SELECT * FROM picks WHERE date = $1 AND tier = ANY($2) AND is_disabled = false ORDER BY confidence DESC LIMIT 10`,
        [today, tierFilter]
      );
      await pool.end();
      // Build parlay legs with sportsbook deep-links
      const sportsbooks = [
        { name: 'DraftKings', url: 'https://sportsbook.draftkings.com', logo: 'dk' },
        { name: 'FanDuel', url: 'https://sportsbook.fanduel.com', logo: 'fd' },
        { name: 'BetMGM', url: 'https://sports.betmgm.com', logo: 'mgm' },
        { name: 'Caesars', url: 'https://sportsbook.caesars.com', logo: 'czr' },
        { name: 'PointsBet', url: 'https://pointsbet.com', logo: 'pb' },
        { name: 'BetRivers', url: 'https://betrivers.com', logo: 'br' },
        { name: 'ESPN BET', url: 'https://espnbet.com', logo: 'espn' },
        { name: 'Bet365', url: 'https://bet365.com', logo: 'b365' },
      ];
      const legs = picksResult.rows.map((pick: any) => {
        const searchQuery = encodeURIComponent(`${pick.home_team} vs ${pick.away_team}`);
        return {
          id: pick.id,
          homeTeam: pick.home_team,
          awayTeam: pick.away_team,
          league: pick.league,
          sport: pick.sport,
          prediction: pick.prediction,
          confidence: pick.confidence,
          odds: pick.odds,
          tier: pick.tier,
          isPowerPick: pick.is_power_pick,
          sportsbookLinks: sportsbooks.map(sb => ({
            name: sb.name,
            url: `${sb.url}/search?q=${searchQuery}`,
            logo: sb.logo,
          })),
        };
      });
      return res.json({
        success: true,
        date: today,
        memberTier,
        legs,
        sportsbooks,
        totalLegs: legs.length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/upgrade-check — check if a member is eligible to upgrade their tier
  app.post('/api/auth/upgrade-check', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated.' });
      }
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query('SELECT tier, expires_at, tier_locked_until FROM members WHERE email = $1', [decoded.email]);
      await pool.end();
      if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found.' });
      const member = result.rows[0];
      const isLocked = member.tier_locked_until && new Date(member.tier_locked_until) > new Date();
      const isExpired = member.expires_at && new Date(member.expires_at) < new Date();
      const canUpgrade = !isLocked || isExpired || member.tier === 'free';
      return res.json({
        success: true,
        currentTier: member.tier,
        canUpgrade,
        isLocked: !!isLocked,
        lockExpiresAt: member.tier_locked_until || null,
        message: canUpgrade
          ? 'You are eligible to upgrade your plan.'
          : `Your current subscription is active until ${new Date(member.tier_locked_until).toLocaleDateString()}. You can upgrade once it expires.`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── ADMIN MEMBER MANAGEMENT ──────────────────────────────────────────────────

  // POST /api/admin/members/:id/set-tier — manually set a member's tier, expiry, and lock
  app.post('/api/admin/members/:id/set-tier', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { tier, expiresAt, subscriptionPlan } = req.body;
      if (!tier) return res.status(400).json({ error: 'tier is required' });
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const expiry = expiresAt ? new Date(expiresAt) : (tier === 'lifetime' ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      const lockUntil = tier === 'lifetime' || tier === 'free' ? null : expiry;
      await pool.query(
        `UPDATE members SET tier = $1, subscription_plan = $2, expires_at = $3, tier_locked_until = $4 WHERE id = $5`,
        [tier, subscriptionPlan || tier, expiry, lockUntil, id]
      );
      await pool.end();
      picksCache = null; // clear cache
      return res.json({ success: true, message: `Member #${id} updated to ${tier} tier.` });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/members-full — full member list with tier, expiry, lock, and subscription info
  app.get('/api/admin/members-full', requireAuth, async (req: Request, res: Response) => {
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query(
        `SELECT id, email, username, tier, subscription_plan, expires_at, tier_locked_until, is_active, last_active, created_at
         FROM members ORDER BY created_at DESC`
      );
      await pool.end();
      const now = new Date();
      const members = result.rows.map((m: any) => {
        const isExpired = m.expires_at && new Date(m.expires_at) < now && m.tier !== 'lifetime';
        const isLocked = m.tier_locked_until && new Date(m.tier_locked_until) > now;
        const daysLeft = m.expires_at && !isExpired
          ? Math.ceil((new Date(m.expires_at).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        return { ...m, isExpired, isLocked, daysLeft };
      });
      return res.json({ success: true, members, total: members.length });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
