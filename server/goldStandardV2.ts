/**
 * Gold Standard V3 Titan XII — 12-Factor Prediction Engine
 * Proprietary weighted scoring model for Soccer & NBA predictions
 */

export interface EngineWeights {
  marketConsensus: number;  // 0.25
  momentum: number;         // 0.15
  quality: number;          // 0.15
  secretSauce: number;      // 0.15
  marketSteam: number;      // 0.12
  travelStress: number;     // 0.05
  refereeBias: number;      // 0.05
  environmental: number;    // 0.04
  psychological: number;    // 0.04
}

export interface FixtureData {
  fixtureId: string | number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: 'soccer' | 'nba';
  date: string;
  // Market data
  homeOdds?: number;
  drawOdds?: number;
  awayOdds?: number;
  openingHomeOdds?: number;
  openingAwayOdds?: number;
  // Form data
  homeForm?: string[];   // e.g. ['W','W','D','L','W']
  awayForm?: string[];
  // Quality
  homeWinRate?: number;
  awayWinRate?: number;
  homeGoalDiff?: number;
  awayGoalDiff?: number;
  // H2H
  h2hHomeWins?: number;
  h2hAwayWins?: number;
  h2hDraws?: number;
  // Rest
  homeRestDays?: number;
  awayRestDays?: number;
  // Injuries
  homeInjuries?: number;
  awayInjuries?: number;
  // Travel
  homeTimezone?: number;
  awayTimezone?: number;
  // Referee
  refereeHomeWinPct?: number;
  refereeStrictness?: number;
  // Weather
  weatherCondition?: string;  // 'clear' | 'rain' | 'snow' | 'wind'
  windSpeed?: number;
  temperature?: number;
  // Venue
  isNeutral?: boolean;
}

export interface PredictionResult {
  fixtureId: string | number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  date: string;
  predictions: {
    homeWin: number;
    draw?: number;
    awayWin: number;
    homeOrDraw?: number;
    awayOrDraw?: number;
    homeOrAway?: number;
    over25?: number;
    under25?: number;
    btts?: number;
  };
  topPick: string;
  topConfidence: number;
  isPowerPick: boolean;
  tier: 'free' | 'vip' | 'pro';
  factors: Record<string, number>;
  recommendation: string;
}

const DEFAULT_WEIGHTS: EngineWeights = {
  marketConsensus: 0.25,
  momentum: 0.15,
  quality: 0.15,
  secretSauce: 0.15,
  marketSteam: 0.12,
  travelStress: 0.05,
  refereeBias: 0.05,
  environmental: 0.04,
  psychological: 0.04,
};

// ─── Factor Calculators ───────────────────────────────────────────────────────

function calcMarketConsensus(homeOdds?: number, drawOdds?: number, awayOdds?: number) {
  if (!homeOdds || !awayOdds) return { home: 0.45, draw: 0.25, away: 0.30 };
  const homeImpl = 1 / homeOdds;
  const drawImpl = drawOdds ? 1 / drawOdds : 0.25;
  const awayImpl = 1 / awayOdds;
  const total = homeImpl + drawImpl + awayImpl;
  return {
    home: homeImpl / total,
    draw: drawImpl / total,
    away: awayImpl / total,
  };
}

function calcMomentum(form?: string[]): number {
  if (!form || form.length === 0) return 0.5;
  const weights = [0.35, 0.25, 0.20, 0.12, 0.08]; // Most recent first
  let score = 0;
  let totalWeight = 0;
  for (let i = 0; i < Math.min(form.length, 5); i++) {
    const w = weights[i];
    const pts = form[i] === 'W' ? 3 : form[i] === 'D' ? 1 : 0;
    score += pts * w;
    totalWeight += 3 * w; // max possible
  }
  return totalWeight > 0 ? score / totalWeight : 0.5;
}

function calcQuality(winRate?: number, goalDiff?: number): number {
  const wr = winRate ?? 0.5;
  const gd = goalDiff ?? 0;
  const gdNorm = Math.max(0, Math.min(1, (gd + 30) / 60)); // normalize -30 to +30
  return wr * 0.7 + gdNorm * 0.3;
}

function calcSecretSauce(
  h2hHomeWins = 0, h2hAwayWins = 0, h2hDraws = 0,
  homeRestDays = 3, awayRestDays = 3,
  homeInjuries = 0, awayInjuries = 0
): { home: number; away: number } {
  // H2H
  const h2hTotal = h2hHomeWins + h2hAwayWins + h2hDraws;
  const h2hHome = h2hTotal > 0 ? h2hHomeWins / h2hTotal : 0.45;
  const h2hAway = h2hTotal > 0 ? h2hAwayWins / h2hTotal : 0.35;

  // Rest advantage
  const restDiff = homeRestDays - awayRestDays;
  const restHome = Math.min(1, Math.max(0, 0.5 + restDiff * 0.05));
  const restAway = 1 - restHome;

  // Injury impact (more injuries = worse)
  const injHome = Math.max(0, 1 - homeInjuries * 0.08);
  const injAway = Math.max(0, 1 - awayInjuries * 0.08);
  const injTotal = injHome + injAway;
  const injHomeNorm = injTotal > 0 ? injHome / injTotal : 0.5;
  const injAwayNorm = injTotal > 0 ? injAway / injTotal : 0.5;

  return {
    home: h2hHome * 0.33 + restHome * 0.33 + injHomeNorm * 0.34,
    away: h2hAway * 0.33 + restAway * 0.33 + injAwayNorm * 0.34,
  };
}

function calcMarketSteam(
  openingHomeOdds?: number, currentHomeOdds?: number,
  openingAwayOdds?: number, currentAwayOdds?: number
): { home: number; away: number } {
  if (!openingHomeOdds || !currentHomeOdds) return { home: 0.5, away: 0.5 };
  // CLV: if odds shortened (lower), sharp money is on that side
  const homeMove = (openingHomeOdds - currentHomeOdds) / openingHomeOdds;
  const awayMove = openingAwayOdds && currentAwayOdds
    ? (openingAwayOdds - currentAwayOdds) / openingAwayOdds
    : 0;
  const homeScore = Math.min(1, Math.max(0, 0.5 + homeMove * 2));
  const awayScore = Math.min(1, Math.max(0, 0.5 + awayMove * 2));
  return { home: homeScore, away: awayScore };
}

function calcTravelStress(homeTimezone = 0, awayTimezone = 0): number {
  // Higher timezone diff = more stress for away team = advantage for home
  const diff = Math.abs(homeTimezone - awayTimezone);
  return Math.min(1, diff / 12);
}

function calcRefereeBias(refereeHomeWinPct = 0.45): number {
  return refereeHomeWinPct;
}

function calcEnvironmental(weatherCondition = 'clear', windSpeed = 0, temperature = 20): number {
  let penalty = 0;
  if (weatherCondition === 'rain') penalty += 0.15;
  if (weatherCondition === 'snow') penalty += 0.25;
  if (windSpeed > 30) penalty += 0.10;
  if (temperature < 0 || temperature > 35) penalty += 0.10;
  return Math.max(0, 1 - penalty);
}

function calcPsychological(refereeStrictness = 0.5, isPressureGame = false): number {
  // Strict referee + pressure game = more draws
  return refereeStrictness * (isPressureGame ? 1.2 : 1.0);
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

export function runTitanXII(fixture: FixtureData, weights: EngineWeights = DEFAULT_WEIGHTS): PredictionResult {
  const { sport } = fixture;

  // Calculate all factors
  const market = calcMarketConsensus(fixture.homeOdds, fixture.drawOdds, fixture.awayOdds);
  const homeMomentum = calcMomentum(fixture.homeForm);
  const awayMomentum = calcMomentum(fixture.awayForm);
  const homeQuality = calcQuality(fixture.homeWinRate, fixture.homeGoalDiff);
  const awayQuality = calcQuality(fixture.awayWinRate, fixture.awayGoalDiff);
  const secretSauce = calcSecretSauce(
    fixture.h2hHomeWins, fixture.h2hAwayWins, fixture.h2hDraws,
    fixture.homeRestDays, fixture.awayRestDays,
    fixture.homeInjuries, fixture.awayInjuries
  );
  const steam = calcMarketSteam(fixture.openingHomeOdds, fixture.homeOdds, fixture.openingAwayOdds, fixture.awayOdds);
  const travelStress = calcTravelStress(fixture.homeTimezone, fixture.awayTimezone);
  const refBias = calcRefereeBias(fixture.refereeHomeWinPct);
  const envFactor = calcEnvironmental(fixture.weatherCondition, fixture.windSpeed, fixture.temperature);
  const psychFactor = calcPsychological(fixture.refereeStrictness);

  // Home advantage baseline
  const homeAdvantage = fixture.isNeutral ? 0 : 0.05;

  // Raw scores for each outcome
  const rawHome =
    market.home * weights.marketConsensus +
    homeMomentum * weights.momentum +
    homeQuality * weights.quality +
    secretSauce.home * weights.secretSauce +
    steam.home * weights.marketSteam +
    travelStress * weights.travelStress +
    refBias * weights.refereeBias +
    envFactor * weights.environmental +
    (1 - psychFactor * 0.5) * weights.psychological +
    homeAdvantage;

  const rawAway =
    market.away * weights.marketConsensus +
    awayMomentum * weights.momentum +
    awayQuality * weights.quality +
    secretSauce.away * weights.secretSauce +
    steam.away * weights.marketSteam +
    (1 - travelStress) * weights.travelStress +
    (1 - refBias) * weights.refereeBias +
    envFactor * weights.environmental +
    (1 - psychFactor * 0.5) * weights.psychological;

  const rawDraw = sport === 'soccer'
    ? market.draw * weights.marketConsensus +
      0.5 * weights.momentum +
      0.5 * weights.quality +
      0.5 * weights.secretSauce +
      0.5 * weights.marketSteam +
      0.5 * weights.travelStress +
      psychFactor * weights.refereeBias +
      envFactor * 0.5 * weights.environmental +
      psychFactor * weights.psychological
    : 0;

  // Normalize
  const totalRaw = rawHome + rawDraw + rawAway;
  let homeConf = (rawHome / totalRaw) * 100;
  let drawConf = sport === 'soccer' ? (rawDraw / totalRaw) * 100 : 0;
  let awayConf = (rawAway / totalRaw) * 100;

  // Adjustments
  if (fixture.refereeStrictness && fixture.refereeStrictness > 0.7 && sport === 'soccer') {
    drawConf += 6;
    homeConf -= 3;
    awayConf -= 3;
  }

  // Weather penalty on goals
  if (fixture.weatherCondition === 'rain' || fixture.windSpeed && fixture.windSpeed > 25) {
    drawConf += 3;
    homeConf -= 1.5;
    awayConf -= 1.5;
  }

  // Double chance calculations (soccer only)
  const homeOrDraw = sport === 'soccer' ? Math.min(95, homeConf + drawConf * 0.7) : undefined;
  const awayOrDraw = sport === 'soccer' ? Math.min(95, awayConf + drawConf * 0.7) : undefined;
  const homeOrAway = sport === 'soccer' ? Math.min(95, homeConf + awayConf) : undefined;

  // Over/Under & BTTS (soccer only)
  const attackStrength = (homeMomentum + awayMomentum) / 2;
  const over25 = sport === 'soccer' ? Math.min(90, attackStrength * 100 * 0.8 + 20) : undefined;
  const under25 = sport === 'soccer' ? Math.min(90, 100 - (over25 || 50)) : undefined;
  const btts = sport === 'soccer' ? Math.min(85, (homeMomentum + awayMomentum) * 50) : undefined;

  // Determine top pick
  const outcomes: Array<[string, number]> = [
    ['Home Win', homeConf],
    ['Away Win', awayConf],
  ];
  if (sport === 'soccer') {
    outcomes.push(['Draw', drawConf]);
    if (homeOrDraw) outcomes.push(['Home or Draw', homeOrDraw]);
    if (awayOrDraw) outcomes.push(['Away or Draw', awayOrDraw]);
    if (over25) outcomes.push(['Over 2.5', over25]);
    if (btts) outcomes.push(['BTTS', btts]);
  }

  outcomes.sort((a, b) => b[1] - a[1]);
  const [topPick, topConfidence] = outcomes[0];

  // Tier assignment
  let tier: 'free' | 'vip' | 'pro' = 'free';
  if (topConfidence >= 69) tier = 'pro';
  else if (topConfidence >= 68) tier = 'vip';
  else if (topConfidence >= 60) tier = 'free';

  const isPowerPick = topConfidence >= 69;

  return {
    fixtureId: fixture.fixtureId,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    league: fixture.league,
    sport: fixture.sport,
    date: fixture.date,
    predictions: {
      homeWin: Math.round(homeConf * 10) / 10,
      draw: sport === 'soccer' ? Math.round(drawConf * 10) / 10 : undefined,
      awayWin: Math.round(awayConf * 10) / 10,
      homeOrDraw: homeOrDraw ? Math.round(homeOrDraw * 10) / 10 : undefined,
      awayOrDraw: awayOrDraw ? Math.round(awayOrDraw * 10) / 10 : undefined,
      homeOrAway: homeOrAway ? Math.round(homeOrAway * 10) / 10 : undefined,
      over25: over25 ? Math.round(over25 * 10) / 10 : undefined,
      under25: under25 ? Math.round(under25 * 10) / 10 : undefined,
      btts: btts ? Math.round(btts * 10) / 10 : undefined,
    },
    topPick,
    topConfidence: Math.round(topConfidence * 10) / 10,
    isPowerPick,
    tier,
    factors: {
      marketConsensus: Math.round(market.home * 100) / 100,
      homeMomentum: Math.round(homeMomentum * 100) / 100,
      awayMomentum: Math.round(awayMomentum * 100) / 100,
      homeQuality: Math.round(homeQuality * 100) / 100,
      awayQuality: Math.round(awayQuality * 100) / 100,
      secretSauceHome: Math.round(secretSauce.home * 100) / 100,
      travelStress: Math.round(travelStress * 100) / 100,
      refereeBias: Math.round(refBias * 100) / 100,
      environmental: Math.round(envFactor * 100) / 100,
    },
    recommendation: `${topPick} — ${Math.round(topConfidence)}% confidence${isPowerPick ? ' ⚡ POWER PICK' : ''}`,
  };
}

// ─── Batch Processing ─────────────────────────────────────────────────────────

export function runBatchPredictions(fixtures: FixtureData[], weights?: EngineWeights): PredictionResult[] {
  const results: PredictionResult[] = [];
  for (const fixture of fixtures) {
    try {
      const result = runTitanXII(fixture, weights);
      // Only include picks meeting minimum threshold
      const minThreshold = fixture.sport === 'nba' ? 55 : 60;
      if (result.topConfidence >= minThreshold) {
        results.push(result);
      }
    } catch (err) {
      console.error(`[Engine] Failed to process fixture ${fixture.fixtureId}:`, err);
    }
  }
  // Sort by confidence descending
  return results.sort((a, b) => b.topConfidence - a.topConfidence);
}
