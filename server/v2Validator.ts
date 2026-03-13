/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   V2 VALIDATOR — Hardened Pick Validation Engine                         ║
 * ║   Zero-Break Protocol: Shadow Mode → Dry Run → Active Mode               ║
 * ║                                                                           ║
 * ║   Thresholds:                                                             ║
 * ║     Featured Picks (Power Pick / Gold Tier):  confidence ≥ 68%           ║
 * ║     Tab Picks (3-Leg NBA / Soccer / MLS):     confidence ≥ 65%           ║
 * ║                                                                           ║
 * ║   V3-15 Factor Audit: 8 of 15 factors must have real (non-default) data  ║
 * ║   Safety Anchors: Class Gap (F03) + Injury Advantage (F07) required      ║
 * ║   Value Gate: V3 confidence > bookmaker implied + 5%                     ║
 * ║                                                                           ║
 * ║   Admin Master Key: Force Publish always bypasses all gates               ║
 * ║   Shadow Mode: logs what would be blocked WITHOUT blocking anything       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { createAlert } from './storage.js';

// ─── Validator Mode ───────────────────────────────────────────────────────────
export type ValidatorMode = 'shadow' | 'active';

let _validatorMode: ValidatorMode = 'shadow'; // Default: Shadow Mode (safe)
let _shadowStartedAt: Date | null = null;
let _shadowLogCount = 0;

export function getValidatorMode(): ValidatorMode { return _validatorMode; }
export function setValidatorMode(mode: ValidatorMode): void {
  const prev = _validatorMode;
  _validatorMode = mode;
  if (mode === 'shadow' && prev !== 'shadow') {
    _shadowStartedAt = new Date();
    _shadowLogCount = 0;
    console.log(`[V2Validator] Switched to SHADOW MODE at ${_shadowStartedAt.toISOString()}`);
  } else if (mode === 'active' && prev !== 'active') {
    console.log(`[V2Validator] Switched to ACTIVE MODE — validator is now BLOCKING low-quality picks`);
  }
}

// ─── Thresholds ───────────────────────────────────────────────────────────────
export const VALIDATOR_THRESHOLDS = {
  FEATURED_MIN:   68,  // Power Pick / Gold Tier / Featured — must be ≥68%
  TAB_MIN:        65,  // 3-Leg NBA / Soccer / MLS tab picks — must be ≥65%
  VALUE_EDGE_MIN:  5,  // V3 confidence must exceed bookmaker implied by ≥5%
  V3_FACTORS_MIN:  8,  // At least 8 of 15 V3-15 factors must have real data
  CLASS_GAP_MIN: 0.05, // F03 quality gap threshold
  INJURY_GAP_MIN: 0.02, // F07 injury gap threshold
} as const;

// ─── Pick Types ───────────────────────────────────────────────────────────────
export type PickType = 'featured' | 'tab' | 'power' | 'gold';

// ─── Validation Input ─────────────────────────────────────────────────────────
export interface ValidatorInput {
  homeTeam: string;
  awayTeam: string;
  prediction: string;
  confidence: number;          // 0-100 percentage
  pickType: PickType;          // 'featured' | 'tab' | 'power' | 'gold'
  forcePublish?: boolean;      // Admin Master Key — bypasses all gates
  factors?: {
    f01_marketConsensus_home?: number;
    f02_momentum_home?: number;
    f02_momentum_away?: number;
    f03_quality_home?: number;
    f03_quality_away?: number;
    f04_h2h_home?: number;
    f04_h2h_away?: number;
    f05_steam_home?: number;
    f05_steam_away?: number;
    f06_rest_home?: number;
    f06_rest_away?: number;
    f07_injuries_home?: number;
    f07_injuries_away?: number;
    f08_travel?: number;
    f09_referee?: number;
    f10_environment?: number;
    f11_standing_home?: number;
    f11_standing_away?: number;
    f12_venue?: number;
    f13_steam_home?: number;
    f14_altitude?: number;
    f15_referee_boost?: number;
    [key: string]: number | undefined;
  };
}

// ─── Validation Result ────────────────────────────────────────────────────────
export interface ValidatorResult {
  isValid: boolean;
  score: number;               // 0-100 composite V3-15 factor score
  factorsPassed: number;       // How many of 15 factors have real data
  factorsTotal: 15;
  confidenceGate: boolean;     // Did it pass the confidence threshold?
  v3AuditGate: boolean;        // Did it pass the V3-15 factor audit?
  safetyGate: boolean;         // Did it pass Class Gap + Injury Advantage?
  valueGate: boolean;          // Did it pass the value edge gate?
  valueGap: number;            // V3 confidence - bookmaker implied (%)
  classGap: number;            // |homeQuality - awayQuality|
  injuryGap: number;           // |homeInjury - awayInjury|
  threshold: number;           // Which threshold was applied (65 or 68)
  blockedBy: string[];         // Which gates blocked this pick (if any)
  forcePublished: boolean;     // Was the Admin Master Key used?
  shadowLogged: boolean;       // Was this logged in shadow mode?
  mode: ValidatorMode;
  details: string;             // Human-readable summary
  v3VerifiedBadge: boolean;    // True if all gates pass (for UI badge)
}

// ─── V3-15 Factor Audit ───────────────────────────────────────────────────────
function runV3FactorAudit(factors: ValidatorInput['factors']): {
  passed: number;
  score: number;
  classGap: number;
  injuryGap: number;
  valueGap: number;
  bookmakerImplied: number;
} {
  if (!factors) return { passed: 0, score: 0, classGap: 0, injuryGap: 0, valueGap: 0, bookmakerImplied: 50 };

  const f01 = (factors.f01_marketConsensus_home ?? 0.44) !== 0.44 && (factors.f01_marketConsensus_home ?? 0.30) !== 0.30;
  const f02 = (factors.f02_momentum_home ?? 0.50) !== 0.50 || (factors.f02_momentum_away ?? 0.50) !== 0.50;
  const f03 = (factors.f03_quality_home ?? 0.50) !== 0.50 || (factors.f03_quality_away ?? 0.50) !== 0.50;
  const f04 = (factors.f04_h2h_home ?? 0.50) !== 0.50 || (factors.f04_h2h_away ?? 0.50) !== 0.50;
  const f05 = (factors.f05_steam_home ?? 0.50) !== 0.50 || (factors.f05_steam_away ?? 0.50) !== 0.50;
  const f06 = (factors.f06_rest_home ?? 0.50) !== 0.50 || (factors.f06_rest_away ?? 0.50) !== 0.50;
  const f07 = (factors.f07_injuries_home ?? 0.90) !== 0.90 || (factors.f07_injuries_away ?? 0.90) !== 0.90;
  const f08 = (factors.f08_travel ?? 0.50) !== 0.50;
  const f09 = (factors.f09_referee ?? 0.50) !== 0.50;
  const f10 = (factors.f10_environment ?? 0.50) !== 0.50;
  const f11 = (factors.f11_standing_home ?? 0.50) !== 0.50 || (factors.f11_standing_away ?? 0.50) !== 0.50;
  const f12 = (factors.f12_venue ?? 0.50) !== 0.50;
  const f13 = factors.f13_steam_home !== undefined && factors.f13_steam_home !== 0.50;
  const f14 = factors.f14_altitude !== undefined && factors.f14_altitude !== 0.50;
  const f15 = factors.f15_referee_boost !== undefined && factors.f15_referee_boost !== 0.50;

  const allFlags = [f01,f02,f03,f04,f05,f06,f07,f08,f09,f10,f11,f12,f13,f14,f15];
  const passed = allFlags.filter(Boolean).length;

  // Composite score: weighted average of factor values (0-100)
  const weights = [10,8,10,7,8,6,10,5,5,5,8,5,4,4,5]; // sum=100
  let score = 0;
  const factorValues = [
    Math.abs((factors.f01_marketConsensus_home ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f02_momentum_home ?? 0.50) - (factors.f02_momentum_away ?? 0.50)),
    Math.abs((factors.f03_quality_home ?? 0.50) - (factors.f03_quality_away ?? 0.50)),
    Math.abs((factors.f04_h2h_home ?? 0.50) - (factors.f04_h2h_away ?? 0.50)),
    Math.abs((factors.f05_steam_home ?? 0.50) - (factors.f05_steam_away ?? 0.50)),
    Math.abs((factors.f06_rest_home ?? 0.50) - (factors.f06_rest_away ?? 0.50)),
    Math.abs((factors.f07_injuries_home ?? 0.90) - (factors.f07_injuries_away ?? 0.90)),
    Math.abs((factors.f08_travel ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f09_referee ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f10_environment ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f11_standing_home ?? 0.50) - (factors.f11_standing_away ?? 0.50)),
    Math.abs((factors.f12_venue ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f13_steam_home ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f14_altitude ?? 0.50) - 0.50) * 2,
    Math.abs((factors.f15_referee_boost ?? 0.50) - 0.50) * 2,
  ];
  for (let i = 0; i < 15; i++) {
    score += Math.min(factorValues[i], 1) * weights[i];
  }

  const classGap = Math.abs((factors.f03_quality_home ?? 0.50) - (factors.f03_quality_away ?? 0.50));
  const injuryGap = Math.abs((factors.f07_injuries_home ?? 0.90) - (factors.f07_injuries_away ?? 0.90));
  const bookmakerImplied = (factors.f01_marketConsensus_home ?? 0.50) * 100;

  return { passed, score: Math.round(score), classGap, injuryGap, valueGap: 0, bookmakerImplied };
}

// ─── Main is_valid() Function ─────────────────────────────────────────────────
/**
 * is_valid() — The V2 Validator core function.
 *
 * Returns true ONLY if:
 *   Featured Picks (Power Pick / Gold Tier): confidence ≥ 68%
 *   Tab Picks (3-Leg NBA / Soccer / MLS):   confidence ≥ 65%
 *   V3-15 Factor Audit: ≥8 of 15 factors have real data
 *   Safety Anchors: Class Gap (F03) + Injury Advantage (F07)
 *   Value Gate: V3 confidence > bookmaker implied + 5%
 *
 * Admin Master Key (forcePublish=true): bypasses ALL gates.
 * Shadow Mode: logs what would be blocked WITHOUT blocking.
 */
export function is_valid(input: ValidatorInput): ValidatorResult {
  const { homeTeam, awayTeam, confidence, pickType, forcePublish = false, factors } = input;
  const matchup = `${homeTeam} vs ${awayTeam}`;
  const mode = _validatorMode;
  const blockedBy: string[] = [];

  // ── Determine threshold based on pick type ────────────────────────────────
  const isFeatured = pickType === 'featured' || pickType === 'power' || pickType === 'gold';
  const threshold = isFeatured
    ? VALIDATOR_THRESHOLDS.FEATURED_MIN   // 68% for featured/power/gold
    : VALIDATOR_THRESHOLDS.TAB_MIN;       // 65% for tab picks (NBA/Soccer/MLS)

  // ── Gate 1: Confidence threshold ──────────────────────────────────────────
  const confidenceGate = confidence >= threshold;
  if (!confidenceGate) {
    blockedBy.push(`Confidence ${confidence}% < ${threshold}% threshold (${isFeatured ? 'featured' : 'tab'} pick)`);
  }

  // ── Gate 2: V3-15 Factor Audit ────────────────────────────────────────────
  const audit = runV3FactorAudit(factors);
  const v3AuditGate = audit.passed >= VALIDATOR_THRESHOLDS.V3_FACTORS_MIN;
  if (!v3AuditGate) {
    blockedBy.push(`V3-15 Audit: only ${audit.passed}/15 factors have real data (need ${VALIDATOR_THRESHOLDS.V3_FACTORS_MIN})`);
  }

  // ── Gate 3: Safety Anchors (Class Gap + Injury Advantage) ─────────────────
  const hasClassGap = audit.classGap > VALIDATOR_THRESHOLDS.CLASS_GAP_MIN;
  const hasInjuryAdvantage = audit.injuryGap > VALIDATOR_THRESHOLDS.INJURY_GAP_MIN
    || ((factors?.f07_injuries_home ?? 0.90) !== 0.90 || (factors?.f07_injuries_away ?? 0.90) !== 0.90);
  const safetyGate = hasClassGap && hasInjuryAdvantage;
  if (!safetyGate) {
    if (!hasClassGap) blockedBy.push(`Safety: No Class Gap (F03 gap=${audit.classGap.toFixed(3)} < ${VALIDATOR_THRESHOLDS.CLASS_GAP_MIN})`);
    if (!hasInjuryAdvantage) blockedBy.push(`Safety: No Injury Advantage (F07 gap=${audit.injuryGap.toFixed(3)} < ${VALIDATOR_THRESHOLDS.INJURY_GAP_MIN})`);
  }

  // ── Gate 4: Value Edge (V3 > bookmaker + 5%) ──────────────────────────────
  const valueGap = confidence - audit.bookmakerImplied;
  const valueGate = valueGap >= VALIDATOR_THRESHOLDS.VALUE_EDGE_MIN;
  if (!valueGate) {
    blockedBy.push(`Value: V3=${confidence}% vs Bookmaker=${audit.bookmakerImplied.toFixed(1)}% — gap=${valueGap.toFixed(1)}% < ${VALIDATOR_THRESHOLDS.VALUE_EDGE_MIN}% required`);
  }

  // ── V3 Verified Badge: all 4 gates pass ───────────────────────────────────
  const allGatesPass = confidenceGate && v3AuditGate && safetyGate && valueGate;
  const v3VerifiedBadge = allGatesPass;

  // ── Admin Master Key: Force Publish bypasses all gates ────────────────────
  if (forcePublish) {
    const msg = `[V2Validator] ⚡ FORCE PUBLISH by Admin Master Key: ${matchup} @ ${confidence}% (${blockedBy.length} gates bypassed: ${blockedBy.join('; ') || 'none'})`;
    console.log(msg);
    createAlert('info', msg).catch(() => {});
    return {
      isValid: true,
      score: audit.score,
      factorsPassed: audit.passed,
      factorsTotal: 15,
      confidenceGate, v3AuditGate, safetyGate, valueGate,
      valueGap, classGap: audit.classGap, injuryGap: audit.injuryGap,
      threshold, blockedBy,
      forcePublished: true,
      shadowLogged: false,
      mode,
      details: `FORCE PUBLISHED by Admin Master Key. ${blockedBy.length} gates bypassed.`,
      v3VerifiedBadge: false, // Force publish does not earn the V3 Verified badge
    };
  }

  // ── Shadow Mode: log what would be blocked WITHOUT blocking ───────────────
  if (mode === 'shadow') {
    _shadowLogCount++;
    if (blockedBy.length > 0) {
      const msg = `[V2Validator] [SHADOW] Would BLOCK: ${matchup} @ ${confidence}% | Blocked by: ${blockedBy.join(' | ')} | V3 Score: ${audit.score}/100 | Factors: ${audit.passed}/15`;
      console.warn(msg);
      // Log to DB every 10 shadow blocks to avoid spam
      if (_shadowLogCount % 10 === 0) {
        createAlert('info', `Shadow Mode: ${_shadowLogCount} picks logged. Last: ${msg}`).catch(() => {});
      }
    } else {
      console.log(`[V2Validator] [SHADOW] Would PASS: ${matchup} @ ${confidence}% | V3 Score: ${audit.score}/100 | Factors: ${audit.passed}/15 | Value Gap: +${valueGap.toFixed(1)}%`);
    }
    // In shadow mode, ALWAYS return true (never block)
    return {
      isValid: true, // Shadow mode never blocks
      score: audit.score,
      factorsPassed: audit.passed,
      factorsTotal: 15,
      confidenceGate, v3AuditGate, safetyGate, valueGate,
      valueGap, classGap: audit.classGap, injuryGap: audit.injuryGap,
      threshold, blockedBy,
      forcePublished: false,
      shadowLogged: true,
      mode: 'shadow',
      details: blockedBy.length > 0
        ? `SHADOW: Would block — ${blockedBy.join('; ')}`
        : `SHADOW: Would pass — V3 Score ${audit.score}/100, ${audit.passed}/15 factors, +${valueGap.toFixed(1)}% value gap`,
      v3VerifiedBadge,
    };
  }

  // ── Active Mode: enforce all gates ────────────────────────────────────────
  const isValid = allGatesPass;

  if (!isValid) {
    console.warn(`[V2Validator] [ACTIVE] BLOCKED: ${matchup} @ ${confidence}% | ${blockedBy.join(' | ')}`);
  } else {
    console.log(`[V2Validator] [ACTIVE] PASSED: ${matchup} @ ${confidence}% ✅ V3 Score: ${audit.score}/100 | Factors: ${audit.passed}/15 | Value Gap: +${valueGap.toFixed(1)}%`);
  }

  return {
    isValid,
    score: audit.score,
    factorsPassed: audit.passed,
    factorsTotal: 15,
    confidenceGate, v3AuditGate, safetyGate, valueGate,
    valueGap, classGap: audit.classGap, injuryGap: audit.injuryGap,
    threshold, blockedBy,
    forcePublished: false,
    shadowLogged: false,
    mode: 'active',
    details: isValid
      ? `VALID — V3 Score ${audit.score}/100, ${audit.passed}/15 factors, +${valueGap.toFixed(1)}% value gap`
      : `BLOCKED — ${blockedBy.join('; ')}`,
    v3VerifiedBadge,
  };
}

// ─── Dry Run Simulation ───────────────────────────────────────────────────────
/**
 * runDryRun() — Simulate the validator against a list of picks.
 * Logs discrepancies where the new logic would have blocked a previous pick.
 * Does NOT modify any data.
 */
export function runDryRun(picks: ValidatorInput[]): {
  total: number;
  wouldPass: number;
  wouldBlock: number;
  discrepancies: Array<{ pick: string; confidence: number; blockedBy: string[]; score: number; factorsPassed: number }>;
  summary: string;
} {
  const discrepancies: Array<{ pick: string; confidence: number; blockedBy: string[]; score: number; factorsPassed: number }> = [];
  let wouldPass = 0;
  let wouldBlock = 0;

  console.log(`\n[V2Validator] ═══ DRY RUN SIMULATION — ${picks.length} picks ═══`);

  for (const pick of picks) {
    // Temporarily force active mode for dry run
    const savedMode = _validatorMode;
    _validatorMode = 'active';
    const result = is_valid(pick);
    _validatorMode = savedMode;

    if (result.isValid) {
      wouldPass++;
      console.log(`[DryRun] ✅ PASS | ${pick.homeTeam} vs ${pick.awayTeam} @ ${pick.confidence}% | Score: ${result.score}/100 | Factors: ${result.factorsPassed}/15 | Gap: +${result.valueGap.toFixed(1)}%`);
    } else {
      wouldBlock++;
      discrepancies.push({
        pick: `${pick.homeTeam} vs ${pick.awayTeam}`,
        confidence: pick.confidence,
        blockedBy: result.blockedBy,
        score: result.score,
        factorsPassed: result.factorsPassed,
      });
      console.warn(`[DryRun] ❌ BLOCK | ${pick.homeTeam} vs ${pick.awayTeam} @ ${pick.confidence}% | ${result.blockedBy.join(' | ')}`);
    }
  }

  const summary = `Dry Run: ${picks.length} picks | ${wouldPass} would PASS | ${wouldBlock} would BLOCK (${discrepancies.length} discrepancies)`;
  console.log(`\n[V2Validator] ═══ DRY RUN COMPLETE ═══`);
  console.log(`[V2Validator] ${summary}`);
  if (discrepancies.length > 0) {
    console.log(`[V2Validator] Discrepancies (picks that would now be blocked):`);
    discrepancies.forEach((d, i) => {
      console.log(`  ${i+1}. ${d.pick} @ ${d.confidence}% — ${d.blockedBy.join('; ')}`);
    });
  }
  console.log(`[V2Validator] ═══════════════════════════════════════════════\n`);

  return { total: picks.length, wouldPass, wouldBlock, discrepancies, summary };
}
