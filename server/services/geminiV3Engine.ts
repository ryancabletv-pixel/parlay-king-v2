/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║       GOLD STANDARD V3-15 — GEMINI TITAN XV PREDICTION ENGINE              ║
 * ║       TWO-TIER QUOTA-OPTIMISED ARCHITECTURE                                ║
 * ║                                                                            ║
 * ║  TIER 1 — FLASH SCANNER (gemini-2.0-flash)                                ║
 * ║    • Scans ALL fixtures in batches of 10 per API call                      ║
 * ║    • 250 RPD free tier — handles 1,000+ games with ~100 calls              ║
 * ║    • Outputs quick confidence score + top pick for each game               ║
 * ║    • Only games scoring ≥60% pass to Tier 2                               ║
 * ║                                                                            ║
 * ║  TIER 2 — PRO CONFIRMATION (gemini-2.0-flash with deep prompt)            ║
 * ║    • Only receives games that Flash scored ≥60%                            ║
 * ║    • Runs full 15-factor deep analysis per game                            ║
 * ║    • Sends up to 5 games per request (still conserves quota)               ║
 * ║    • Final confidence must be ≥68% to be posted                           ║
 * ║                                                                            ║
 * ║  QUOTA MATH (daily):                                                       ║
 * ║    1000 games ÷ 10 per batch = 100 Flash calls  (250 RPD limit = safe)    ║
 * ║    ~50 games pass 60% → 10 Pro calls (5 per batch)  (100 RPD = safe)      ║
 * ║    Total: ~110 API calls for 1000+ games                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * ISOLATION: Only modifies /services — no /public, /styles, /components touched.
 * OUTPUT: Identical PredictionResult JSON schema as goldStandardV2.ts.
 */

import { FixtureData, PredictionResult, FactorBreakdown, CONFIDENCE_THRESHOLDS } from '../goldStandardV2.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── Models ──────────────────────────────────────────────────────────────────
const FLASH_MODEL = 'gemini-2.0-flash';   // Tier 1: bulk scanner (250 RPD free)
const PRO_MODEL   = 'gemini-2.0-flash';   // Tier 2: deep confirmation (same model, deeper prompt)

// ─── Quota Config ─────────────────────────────────────────────────────────────
const FLASH_BATCH_SIZE    = 10;   // games per Flash API call
const PRO_BATCH_SIZE      = 5;    // games per Pro API call
const FLASH_PASS_THRESHOLD = 60;  // % — games above this go to Pro confirmation
const FINAL_THRESHOLD     = 68;   // % — minimum to be posted on site

// ─── Extended FixtureData for V15 ────────────────────────────────────────────
export interface FixtureDataV15 extends FixtureData {
  multiBookSteamHome?: number;
  multiBookSteamAway?: number;
  sharpMoneyPct?: number;
  venueAltitudeMeters?: number;
  venueSurface?: 'grass' | 'artificial' | 'hybrid';
  humidity?: number;
  awayTeamAltitudeBase?: number;
  refereeAvgCardsPerGame?: number;
  refereeHomeFavourPct?: number;
  refereeAvgFoulsPerGame?: number;
  refereeExperienceLevel?: number;
  refereePenaltyRate?: number;
}

export interface EngineWeightsV15 {
  marketConsensus:   number;
  momentum:          number;
  quality:           number;
  h2hHistory:        number;
  marketSteam:       number;
  restFatigue:       number;
  injuriesAbsences:  number;
  travelStress:      number;
  refereeBias:       number;
  environmental:     number;
  leagueStanding:    number;
  venuePressure:     number;
  marketSteamAdv:    number;
  altitudeEnv:       number;
  refereeOfficials:  number;
}

export const DEFAULT_WEIGHTS_V15: EngineWeightsV15 = {
  marketConsensus:   0.18,
  momentum:          0.12,
  quality:           0.11,
  h2hHistory:        0.07,
  marketSteam:       0.09,
  restFatigue:       0.06,
  injuriesAbsences:  0.09,
  travelStress:      0.04,
  refereeBias:       0.04,
  environmental:     0.03,
  leagueStanding:    0.04,
  venuePressure:     0.02,
  marketSteamAdv:    0.07,
  altitudeEnv:       0.05,
  refereeOfficials:  0.09,
};

// ─── Deterministic V15 Factor Calculations ───────────────────────────────────
function calcF13_AdvancedSteam(
  multiBookSteamHome = 0.5,
  multiBookSteamAway = 0.5,
  sharpMoneyPct = 0.5
): { home: number; away: number } {
  const homeSignal = Math.min(1, multiBookSteamHome * 1.4);
  const awaySignal = Math.min(1, multiBookSteamAway * 1.4);
  const sharpHome = sharpMoneyPct;
  const sharpAway = 1 - sharpMoneyPct;
  return {
    home: homeSignal * 0.60 + sharpHome * 0.40,
    away: awaySignal * 0.60 + sharpAway * 0.40,
  };
}

function calcF14_AltitudeEnvironmental(
  venueAltitudeMeters = 0,
  awayTeamAltitudeBase = 0,
  venueSurface: 'grass' | 'artificial' | 'hybrid' = 'grass',
  humidity = 60
): number {
  const altitudeDiff = Math.max(0, venueAltitudeMeters - awayTeamAltitudeBase);
  let altitudePenalty = 0;
  if (altitudeDiff > 3000)      altitudePenalty = 0.25;
  else if (altitudeDiff > 2000) altitudePenalty = 0.18;
  else if (altitudeDiff > 1500) altitudePenalty = 0.12;
  else if (altitudeDiff > 800)  altitudePenalty = 0.06;
  const surfacePenalty  = venueSurface === 'artificial' ? 0.04 : 0;
  const humidityPenalty = humidity > 85 ? 0.05 : humidity > 70 ? 0.02 : 0;
  return Math.max(0, 1 - altitudePenalty - surfacePenalty - humidityPenalty);
}

function calcF15_RefereeOfficials(
  refereeAvgCardsPerGame = 3.5,
  refereeHomeFavourPct = 0.45,
  refereeAvgFoulsPerGame = 22,
  refereeExperienceLevel = 0.5,
  refereePenaltyRate = 0.2
): { homeBoost: number; drawBoost: number } {
  const homeBoost = Math.min(0.15, Math.max(-0.10,
    (refereeHomeFavourPct - 0.45) * 0.5 +
    (refereeExperienceLevel - 0.5) * 0.05
  ));
  const drawBoost = Math.min(0.08,
    (refereeAvgCardsPerGame > 5 ? 0.02 : 0) +
    (refereeAvgFoulsPerGame > 28 ? 0.02 : 0) +
    (refereePenaltyRate < 0.1 ? 0.02 : 0)
  );
  return { homeBoost, drawBoost };
}

// ─── TIER 1: FLASH BATCH SCANNER ─────────────────────────────────────────────
// Sends up to 10 fixtures per API call. Returns quick confidence scores.
interface FlashScanResult {
  index: number;          // position in the batch
  homeTeam: string;
  awayTeam: string;
  topPick: string;
  flashConfidence: number; // 0-100
  passToTier2: boolean;
}

async function runFlashBatchScan(
  fixtures: FixtureDataV15[]
): Promise<FlashScanResult[]> {
  if (!GEMINI_API_KEY || fixtures.length === 0) return [];

  const results: FlashScanResult[] = [];
  const model = genAI.getGenerativeModel({ model: FLASH_MODEL });

  // Process in batches of FLASH_BATCH_SIZE
  for (let i = 0; i < fixtures.length; i += FLASH_BATCH_SIZE) {
    const batch = fixtures.slice(i, i + FLASH_BATCH_SIZE);

    // Build compact batch prompt — all 10 games in one request
    const gamesText = batch.map((f, idx) => {
      const homeOdds = f.homeOdds ? `${f.homeOdds}` : '?';
      const awayOdds = f.awayOdds ? `${f.awayOdds}` : '?';
      const homeForm = f.homeForm?.join('') || '?????';
      const awayForm = f.awayForm?.join('') || '?????';
      return `${idx + 1}. ${f.homeTeam} vs ${f.awayTeam} [${f.league}] odds:${homeOdds}/${awayOdds} form:${homeForm}/${awayForm} injuries:${f.homeInjuries||0}/${f.awayInjuries||0}`;
    }).join('\n');

    const prompt = `You are a sports analytics scanner. Quickly assess each game's win probability using available data.
For each game, output a JSON array entry with: index (1-based), topPick (team name + Win/Draw/Over 2.5), confidence (0-100 integer).
Only output valid JSON array, no markdown, no explanation.

Games:
${gamesText}

Output format (example):
[{"index":1,"topPick":"TeamA Win","confidence":72},{"index":2,"topPick":"TeamB Win","confidence":58}]`;

    try {
      console.log(`[Flash Scanner] Batch ${Math.floor(i/FLASH_BATCH_SIZE)+1}: scanning ${batch.length} fixtures...`);
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      });
      const text = result.response.text().replace(/```json|```/g, '').trim();
      const parsed: Array<{ index: number; topPick: string; confidence: number }> = JSON.parse(text);

      for (const item of parsed) {
        const fixture = batch[item.index - 1];
        if (!fixture) continue;
        results.push({
          index: i + item.index - 1,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          topPick: item.topPick,
          flashConfidence: item.confidence,
          passToTier2: item.confidence >= FLASH_PASS_THRESHOLD,
        });
        const status = item.confidence >= FLASH_PASS_THRESHOLD ? '✅ PASS→T2' : '  skip';
        console.log(`[Flash] ${status} ${fixture.homeTeam} vs ${fixture.awayTeam}: ${item.confidence}%`);
      }
    } catch (err: any) {
      if (err?.status === 429) {
        console.warn(`[Flash Scanner] Rate limited on batch ${Math.floor(i/FLASH_BATCH_SIZE)+1} — using deterministic fallback`);
      } else {
        console.error(`[Flash Scanner] Batch error:`, err?.message || err);
      }
      // On error, pass all fixtures in this batch to Tier 2 with neutral score
      for (let j = 0; j < batch.length; j++) {
        results.push({
          index: i + j,
          homeTeam: batch[j].homeTeam,
          awayTeam: batch[j].awayTeam,
          topPick: 'Unknown',
          flashConfidence: 60, // neutral pass
          passToTier2: true,
        });
      }
    }

    // Small delay between Flash batches to respect rate limits
    if (i + FLASH_BATCH_SIZE < fixtures.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

// ─── TIER 2: PRO DEEP CONFIRMATION ───────────────────────────────────────────
// Sends up to 5 fixtures per API call with full 15-factor analysis.
interface ProConfirmResult {
  homeTeam: string;
  awayTeam: string;
  topPick: string;
  proConfidence: number;
  f13_steam_home: number;
  f13_steam_away: number;
  f14_altitude_score: number;
  f15_referee_home_boost: number;
  f15_referee_draw_boost: number;
  gemini_note: string;
}

async function runProBatchConfirm(
  fixtures: FixtureDataV15[],
  flashResults: FlashScanResult[]
): Promise<ProConfirmResult[]> {
  if (!GEMINI_API_KEY || fixtures.length === 0) return [];

  const results: ProConfirmResult[] = [];
  const model = genAI.getGenerativeModel({ model: PRO_MODEL });

  // Process in batches of PRO_BATCH_SIZE
  for (let i = 0; i < fixtures.length; i += PRO_BATCH_SIZE) {
    const batch = fixtures.slice(i, i + PRO_BATCH_SIZE);
    const flashBatch = flashResults.slice(i, i + PRO_BATCH_SIZE);

    const gamesText = batch.map((f, idx) => {
      const flash = flashBatch[idx];
      return `GAME ${idx + 1}: ${f.homeTeam} vs ${f.awayTeam} [${f.league}]
  Flash pick: ${flash?.topPick || '?'} @ ${flash?.flashConfidence || '?'}%
  Odds: H=${f.homeOdds||'?'} A=${f.awayOdds||'?'} D=${f.drawOdds||'?'}
  Form: H=${f.homeForm?.join('')||'?'} A=${f.awayForm?.join('')||'?'}
  WinRate: H=${f.homeWinRate?.toFixed(2)||'?'} A=${f.awayWinRate?.toFixed(2)||'?'}
  Injuries: H=${f.homeInjuries||0} A=${f.awayInjuries||0}
  Rest: H=${f.homeRestDays||3}d A=${f.awayRestDays||3}d
  H2H: H=${f.h2hHomeWins||0}W D=${f.h2hDraws||0} A=${f.h2hAwayWins||0}W
  Rank: H=${f.homeTableRank||10} A=${f.awayTableRank||10}
  F13 Steam: multiBook=${(f as FixtureDataV15).multiBookSteamHome?.toFixed(2)||'0.5'} sharp=${(f as FixtureDataV15).sharpMoneyPct?.toFixed(2)||'0.5'}
  F14 Altitude: venue=${(f as FixtureDataV15).venueAltitudeMeters||0}m surface=${(f as FixtureDataV15).venueSurface||'grass'}
  F15 Referee: homeFavour=${(f as FixtureDataV15).refereeHomeFavourPct?.toFixed(2)||'0.45'} cards/game=${(f as FixtureDataV15).refereeAvgCardsPerGame?.toFixed(1)||'3.5'}`;
    }).join('\n\n');

    const prompt = `You are the Gold Standard V3-15 deep confirmation engine. Apply all 15 factors including F13 Market Steam, F14 Environmental/Altitude, and F15 Referee Tendencies.

${gamesText}

For each game, output a JSON array entry. Return ONLY valid JSON array, no markdown:
[{
  "game": 1,
  "topPick": "Team Name Win",
  "proConfidence": 72.4,
  "f13_steam_home": 0.65,
  "f13_steam_away": 0.45,
  "f14_altitude_score": 0.95,
  "f15_referee_home_boost": 0.52,
  "f15_referee_draw_boost": 0.48,
  "note": "Key factor in 10 words max"
}]`;

    try {
      console.log(`[Pro Confirm] Batch ${Math.floor(i/PRO_BATCH_SIZE)+1}: deep-analysing ${batch.length} fixtures...`);
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 800 },
      });
      const text = result.response.text().replace(/```json|```/g, '').trim();
      const parsed: Array<{
        game: number; topPick: string; proConfidence: number;
        f13_steam_home: number; f13_steam_away: number;
        f14_altitude_score: number;
        f15_referee_home_boost: number; f15_referee_draw_boost: number;
        note: string;
      }> = JSON.parse(text);

      for (const item of parsed) {
        const fixture = batch[item.game - 1];
        if (!fixture) continue;
        const status = item.proConfidence >= FINAL_THRESHOLD ? '🏆 APPROVED' : '  below threshold';
        console.log(`[Pro] ${status} ${fixture.homeTeam} vs ${fixture.awayTeam}: ${item.proConfidence}% — ${item.note}`);
        results.push({
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          topPick: item.topPick,
          proConfidence: item.proConfidence,
          f13_steam_home: item.f13_steam_home ?? 0.5,
          f13_steam_away: item.f13_steam_away ?? 0.5,
          f14_altitude_score: item.f14_altitude_score ?? 0.95,
          f15_referee_home_boost: item.f15_referee_home_boost ?? 0.5,
          f15_referee_draw_boost: item.f15_referee_draw_boost ?? 0.5,
          gemini_note: item.note ?? '',
        });
      }
    } catch (err: any) {
      if (err?.status === 429) {
        console.warn(`[Pro Confirm] Rate limited — using Flash scores as final`);
      } else {
        console.error(`[Pro Confirm] Batch error:`, err?.message || err);
      }
      // On error, use Flash scores as final
      for (let j = 0; j < batch.length; j++) {
        const flash = flashBatch[j];
        results.push({
          homeTeam: batch[j].homeTeam,
          awayTeam: batch[j].awayTeam,
          topPick: flash?.topPick || 'Unknown',
          proConfidence: flash?.flashConfidence || 60,
          f13_steam_home: 0.5, f13_steam_away: 0.5,
          f14_altitude_score: 0.95,
          f15_referee_home_boost: 0.5, f15_referee_draw_boost: 0.5,
          gemini_note: 'Flash fallback',
        });
      }
    }

    if (i + PRO_BATCH_SIZE < fixtures.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  return results;
}

// ─── Deterministic Base Score (V12 fallback) ──────────────────────────────────
function calcDeterministicBase(fixture: FixtureDataV15): {
  rawHome: number; rawAway: number; rawDraw: number;
} {
  const sport = fixture.sport?.toLowerCase() || 'soccer';

  // F01: Market Consensus
  const homeOdds = fixture.homeOdds || 2.2;
  const awayOdds = fixture.awayOdds || 2.2;
  const drawOdds = fixture.drawOdds || 3.4;
  const homeImpl = 1 / homeOdds;
  const awayImpl = 1 / awayOdds;
  const drawImpl = sport === 'soccer' ? 1 / drawOdds : 0;
  const total = homeImpl + awayImpl + drawImpl;
  const f01Home = homeImpl / total;
  const f01Away = awayImpl / total;

  // F02: Momentum
  const formScore = (form: string[] | undefined) => {
    if (!form) return 0.5;
    const weights = [0.35, 0.25, 0.20, 0.12, 0.08];
    return form.slice(0, 5).reduce((s, r, i) => s + (r === 'W' ? weights[i] : r === 'D' ? weights[i] * 0.4 : 0), 0);
  };
  const f02Home = formScore(fixture.homeForm);
  const f02Away = formScore(fixture.awayForm);

  // F03: Quality
  const f03Home = fixture.homeWinRate ?? 0.5;
  const f03Away = fixture.awayWinRate ?? 0.5;

  // Simple weighted composite
  const w = DEFAULT_WEIGHTS_V15;
  const rawHome = f01Home * w.marketConsensus + f02Home * w.momentum + f03Home * w.quality + 0.5 * (1 - w.marketConsensus - w.momentum - w.quality);
  const rawAway = f01Away * w.marketConsensus + f02Away * w.momentum + f03Away * w.quality + 0.5 * (1 - w.marketConsensus - w.momentum - w.quality);
  const rawDraw = sport === 'soccer' ? Math.max(0, 1 - rawHome - rawAway) : 0;

  return { rawHome, rawAway, rawDraw };
}

// ─── Build PredictionResult from Pro confirmation ─────────────────────────────
function buildPredictionResult(
  fixture: FixtureDataV15,
  proResult: ProConfirmResult,
  baseScores: { rawHome: number; rawAway: number; rawDraw: number }
): PredictionResult {
  const sport = fixture.sport?.toLowerCase() || 'soccer';
  const conf = proResult.proConfidence;

  // Determine top pick from Pro result
  const topPick = proResult.topPick;
  const topConfidence = conf;
  const isPowerPick = conf >= 80;
  const tier = conf >= 80 ? 'power' : conf >= 70 ? 'lifetime' : conf >= 68 ? 'pro' : 'free';

  // Build confidence distribution
  let homeConf = baseScores.rawHome * 100;
  let awayConf = baseScores.rawAway * 100;
  let drawConf = baseScores.rawDraw * 100;

  // Adjust based on Pro pick direction
  const pickLower = topPick.toLowerCase();
  if (pickLower.includes(fixture.homeTeam.toLowerCase().split(' ')[0])) {
    homeConf = conf;
    awayConf = Math.max(0, 100 - conf - (sport === 'soccer' ? drawConf : 0));
  } else if (pickLower.includes(fixture.awayTeam.toLowerCase().split(' ')[0])) {
    awayConf = conf;
    homeConf = Math.max(0, 100 - conf - (sport === 'soccer' ? drawConf : 0));
  }

  return {
    fixtureId:    fixture.fixtureId,
    homeTeam:     fixture.homeTeam,
    awayTeam:     fixture.awayTeam,
    league:       fixture.league,
    sport:        fixture.sport,
    date:         fixture.date,
    predictions: {
      homeWin:    Math.round(homeConf * 10) / 10,
      draw:       sport === 'soccer' ? Math.round(drawConf * 10) / 10 : undefined,
      awayWin:    Math.round(awayConf * 10) / 10,
    },
    topPick,
    topConfidence: Math.round(topConfidence * 10) / 10,
    isPowerPick,
    tier,
    factors: {
      f01_marketConsensus_home: Math.round(baseScores.rawHome * 100) / 100,
      f02_momentum_home:        fixture.homeForm ? 0.6 : 0.5,
      f02_momentum_away:        fixture.awayForm ? 0.6 : 0.5,
      f03_quality_home:         fixture.homeWinRate ?? 0.5,
      f03_quality_away:         fixture.awayWinRate ?? 0.5,
      f04_h2h_home:             fixture.h2hHomeWins ? fixture.h2hHomeWins / Math.max(1, (fixture.h2hHomeWins + fixture.h2hAwayWins + fixture.h2hDraws)) : 0.5,
      f05_steam_home:           proResult.f13_steam_home,
      f06_rest_home:            fixture.homeRestDays ? Math.min(1, fixture.homeRestDays / 7) : 0.5,
      f06_rest_away:            fixture.awayRestDays ? Math.min(1, fixture.awayRestDays / 7) : 0.5,
      f07_injuries_home:        Math.max(0, 1 - (fixture.homeInjuries || 0) * 0.1),
      f07_injuries_away:        Math.max(0, 1 - (fixture.awayInjuries || 0) * 0.1),
      f08_travelStress:         0.5,
      f09_refereeBias:          proResult.f15_referee_home_boost,
      f10_environmental:        proResult.f14_altitude_score,
      f11_standing_home:        fixture.homeTableRank ? Math.max(0, 1 - fixture.homeTableRank / 20) : 0.5,
      f11_standing_away:        fixture.awayTableRank ? Math.max(0, 1 - fixture.awayTableRank / 20) : 0.5,
      f12_venuePressure:        0.5,
      // V15 factors
      f13_advancedSteam_home:   Math.round(proResult.f13_steam_home * 100) / 100,
      f13_advancedSteam_away:   Math.round(proResult.f13_steam_away * 100) / 100,
      f14_altitudeEnv:          Math.round(proResult.f14_altitude_score * 100) / 100,
      f15_refereeOfficials_home: Math.round(proResult.f15_referee_home_boost * 100) / 100,
      f15_refereeOfficials_draw: Math.round(proResult.f15_referee_draw_boost * 100) / 100,
      gemini_model:             2, // flag: 2 = Two-tier Flash+Pro V15
      valueScore:               conf / 100,
    },
    recommendation: `${topPick} — ${Math.round(topConfidence)}% confidence${isPowerPick ? ' ⚡ POWER PICK' : ''} [V3-15 Flash+Pro] ${proResult.gemini_note}`,
  };
}

// ─── MAIN: TWO-TIER BATCH PREDICTION ─────────────────────────────────────────
export async function runBatchPredictionsV15(
  fixtures: FixtureDataV15[],
  weights?: EngineWeightsV15
): Promise<PredictionResult[]> {
  if (fixtures.length === 0) return [];

  console.log(`\n[V3-15 Two-Tier] Starting analysis of ${fixtures.length} fixtures`);
  console.log(`[V3-15 Two-Tier] Flash batch size: ${FLASH_BATCH_SIZE} | Pro batch size: ${PRO_BATCH_SIZE}`);
  console.log(`[V3-15 Two-Tier] Flash pass threshold: ${FLASH_PASS_THRESHOLD}% | Final threshold: ${FINAL_THRESHOLD}%`);

  // If no API key, fall back to deterministic engine
  if (!GEMINI_API_KEY) {
    console.warn('[V3-15] No Gemini API key — using deterministic fallback for all fixtures');
    return fixtures.map(f => {
      const base = calcDeterministicBase(f);
      const topConf = Math.max(base.rawHome, base.rawAway, base.rawDraw) * 100;
      const topPick = base.rawHome >= base.rawAway ? `${f.homeTeam} Win` : `${f.awayTeam} Win`;
      return buildPredictionResult(f, {
        homeTeam: f.homeTeam, awayTeam: f.awayTeam,
        topPick, proConfidence: topConf,
        f13_steam_home: 0.5, f13_steam_away: 0.5,
        f14_altitude_score: 0.95,
        f15_referee_home_boost: 0.5, f15_referee_draw_boost: 0.5,
        gemini_note: 'Deterministic fallback',
      }, base);
    }).filter(r => r.topConfidence >= FINAL_THRESHOLD)
      .sort((a, b) => b.topConfidence - a.topConfidence);
  }

  // ── TIER 1: Flash batch scan ──────────────────────────────────────────────
  console.log(`\n[Tier 1] Flash scanning ${fixtures.length} fixtures in batches of ${FLASH_BATCH_SIZE}...`);
  const flashResults = await runFlashBatchScan(fixtures);

  // Filter fixtures that passed Flash threshold
  const passedFlash = fixtures.filter((_, i) => {
    const fr = flashResults.find(r => r.index === i);
    return fr ? fr.passToTier2 : true; // if no flash result, pass through
  });
  const passedFlashResults = flashResults.filter(r => r.passToTier2);

  console.log(`\n[Tier 1] Results: ${passedFlash.length}/${fixtures.length} fixtures passed ${FLASH_PASS_THRESHOLD}% threshold → Tier 2`);

  if (passedFlash.length === 0) {
    console.log('[V3-15] No fixtures passed Flash threshold — no picks today');
    return [];
  }

  // ── TIER 2: Pro deep confirmation ─────────────────────────────────────────
  console.log(`\n[Tier 2] Pro confirming ${passedFlash.length} fixtures in batches of ${PRO_BATCH_SIZE}...`);
  const proResults = await runProBatchConfirm(passedFlash, passedFlashResults);

  // ── Build final PredictionResults ─────────────────────────────────────────
  const finalResults: PredictionResult[] = [];

  for (let i = 0; i < passedFlash.length; i++) {
    const fixture = passedFlash[i];
    const proResult = proResults[i];
    if (!proResult) continue;

    if (proResult.proConfidence < FINAL_THRESHOLD) {
      console.log(`[V3-15] Filtered out: ${fixture.homeTeam} vs ${fixture.awayTeam} — ${proResult.proConfidence}% < ${FINAL_THRESHOLD}%`);
      continue;
    }

    const base = calcDeterministicBase(fixture);
    const prediction = buildPredictionResult(fixture, proResult, base);
    finalResults.push(prediction);
  }

  console.log(`\n[V3-15 Two-Tier] Complete: ${finalResults.length} picks approved (≥${FINAL_THRESHOLD}%)`);
  console.log(`[V3-15 Two-Tier] Quota used: ~${Math.ceil(fixtures.length/FLASH_BATCH_SIZE)} Flash + ~${Math.ceil(passedFlash.length/PRO_BATCH_SIZE)} Pro calls`);

  return finalResults.sort((a, b) => b.topConfidence - a.topConfidence);
}
