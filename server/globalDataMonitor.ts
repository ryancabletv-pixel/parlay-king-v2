/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   GLOBAL DATA MONITOR — 60-Minute Persistent Cron                       ║
 * ║   Runs every 60 minutes to check for new global sports data.             ║
 * ║   Tracks state via last_update.json to prevent duplicate work.           ║
 * ║   3-Attempt Kill-Switch: stops and alerts after 3 failed attempts.       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Responsibilities:
 *  1. Check if today's picks are missing or stale (< 6 picks)
 *  2. If missing: attempt to trigger generation (max 3 attempts, then STOP + alert)
 *  3. Track all attempts in last_update.json to avoid redundant API calls
 *  4. Expand global league coverage: European, South American, Asian markets
 *  5. NEVER run if dailyRunCompleted is true (picks already live)
 *  6. NEVER exceed the 90/100 API call throttle guard
 */

import * as fs from 'fs';
import * as path from 'path';
import { createAlert, getPicksByDate } from './storage.js';
import { getBudgetStatus } from './apis/oddsApi.js';

// ─── State File Path ──────────────────────────────────────────────────────────
const STATE_FILE = path.join(process.cwd(), 'last_update.json');

// ─── State Interface ──────────────────────────────────────────────────────────
interface LastUpdateState {
  date: string;                    // YYYY-MM-DD of last successful generation
  lastSuccessAt: string | null;    // ISO timestamp of last successful run
  lastCheckAt: string | null;      // ISO timestamp of last monitor check
  attemptCount: number;            // How many generation attempts today
  killSwitchTriggered: boolean;    // True if 3 attempts failed — STOP
  killSwitchAt: string | null;     // ISO timestamp when kill-switch fired
  picksLive: number;               // How many picks are currently live
  globalLeaguesScanned: string[];  // Which global leagues were scanned today
  alertSent: boolean;              // Whether the kill-switch alert was sent
}

const DEFAULT_STATE: LastUpdateState = {
  date: '',
  lastSuccessAt: null,
  lastCheckAt: null,
  attemptCount: 0,
  killSwitchTriggered: false,
  killSwitchAt: null,
  picksLive: 0,
  globalLeaguesScanned: [],
  alertSent: false,
};

// ─── State I/O ────────────────────────────────────────────────────────────────
function readState(): LastUpdateState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch {
    // Ignore read errors — use default
  }
  return { ...DEFAULT_STATE };
}

function writeState(state: LastUpdateState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: any) {
    console.error('[GlobalMonitor] Failed to write state file:', err.message);
  }
}

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
}

// ─── Kill-Switch Constants ────────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;         // Maximum generation attempts before kill-switch
const MIN_PICKS_THRESHOLD = 6;  // Minimum picks to consider the day "complete"
const HARD_FLOOR_PCT = 65;      // Absolute minimum confidence — no pick below this

// ─── Global League Coverage ───────────────────────────────────────────────────
// All leagues the monitor will verify are being covered during diversity checks.
// This is the source of truth for global league expansion.
export const GLOBAL_LEAGUE_COVERAGE = {
  europe: [
    'soccer_epl',               // English Premier League
    'soccer_spain_la_liga',     // La Liga
    'soccer_italy_serie_a',     // Serie A
    'soccer_germany_bundesliga',// Bundesliga
    'soccer_france_ligue_one',  // Ligue 1
    'soccer_netherlands_eredivisie', // Eredivisie
    'soccer_portugal_primeira_liga', // Primeira Liga
    'soccer_turkey_super_league',    // Süper Lig
    'soccer_scotland_premiership',   // Scottish Premiership
    'soccer_belgium_first_div',      // Belgian Pro League
    'soccer_uefa_champs_league',     // UEFA Champions League
    'soccer_uefa_europa_league',     // UEFA Europa League
  ],
  south_america: [
    'soccer_brazil_campeonato',           // Brasileirão
    'soccer_argentina_primera_division',  // Argentine Primera
    'soccer_mexico_ligamx',               // Liga MX
    'soccer_colombia_primera_a',          // Colombian Primera A
  ],
  asia_oceania: [
    'soccer_japan_j_league',          // J1 League
    'soccer_south_korea_kleague1',    // K League 1
    'soccer_australia_aleague',       // A-League
    'soccer_saudi_professional_league', // Saudi Pro League
    'soccer_china_superleague',       // Chinese Super League
  ],
  basketball: [
    'basketball_nba',                 // NBA
    'basketball_euroleague',          // EuroLeague
    'basketball_ncaab',               // NCAA Basketball
  ],
};

export const ALL_GLOBAL_LEAGUES = [
  ...GLOBAL_LEAGUE_COVERAGE.europe,
  ...GLOBAL_LEAGUE_COVERAGE.south_america,
  ...GLOBAL_LEAGUE_COVERAGE.asia_oceania,
  ...GLOBAL_LEAGUE_COVERAGE.basketball,
];

// ─── Main Monitor Function ────────────────────────────────────────────────────
export async function runGlobalDataMonitor(
  runGenerationFn: (triggeredBy: string) => Promise<boolean>,
  isDailyRunCompleted: () => boolean
): Promise<void> {
  const today = todayStr();
  const now = new Date().toISOString();

  // Load state
  let state = readState();

  // Reset state if it's a new day
  if (state.date !== today) {
    console.log(`[GlobalMonitor] New day detected (${today}) — resetting state`);
    state = {
      ...DEFAULT_STATE,
      date: today,
      lastCheckAt: now,
    };
    writeState(state);
  }

  state.lastCheckAt = now;

  // ── Guard 1: Daily run already completed ────────────────────────────────────
  if (isDailyRunCompleted()) {
    const picks = await getPicksByDate(today).catch(() => []);
    state.picksLive = picks.length;
    writeState(state);
    console.log(`[GlobalMonitor] Daily run complete — ${picks.length} picks live. No action needed.`);
    return;
  }

  // ── Guard 2: Kill-switch already triggered ───────────────────────────────────
  if (state.killSwitchTriggered) {
    if (!state.alertSent) {
      const msg = `[GlobalMonitor] KILL-SWITCH ACTIVE for ${today}: ${MAX_ATTEMPTS} generation attempts failed to meet the 65% threshold. Manual intervention required.`;
      console.error(msg);
      await createAlert('critical', msg).catch(() => {});
      state.alertSent = true;
      writeState(state);
    }
    console.log(`[GlobalMonitor] Kill-switch active — no further attempts for ${today}.`);
    return;
  }

  // ── Guard 3: API throttle ────────────────────────────────────────────────────
  const budget = getBudgetStatus();
  if (budget.used_today >= 90) {
    console.warn(`[GlobalMonitor] THROTTLE GUARD: ${budget.used_today}/100 API calls used. Skipping monitor run.`);
    writeState(state);
    return;
  }

  // ── Check current pick count ─────────────────────────────────────────────────
  const existingPicks = await getPicksByDate(today).catch(() => []);
  state.picksLive = existingPicks.length;

  if (existingPicks.length >= MIN_PICKS_THRESHOLD) {
    console.log(`[GlobalMonitor] ${existingPicks.length} picks live for ${today} — threshold met. No action needed.`);
    state.lastSuccessAt = now;
    writeState(state);
    return;
  }

  // ── Attempt generation ───────────────────────────────────────────────────────
  state.attemptCount += 1;

  // ── KILL-SWITCH: 3 attempts exceeded ────────────────────────────────────────
  if (state.attemptCount > MAX_ATTEMPTS) {
    state.killSwitchTriggered = true;
    state.killSwitchAt = now;
    const msg = `[GlobalMonitor] ⛔ KILL-SWITCH TRIGGERED for ${today}: ${MAX_ATTEMPTS} generation attempts exhausted. Picks live: ${existingPicks.length}/${MIN_PICKS_THRESHOLD}. Hard floor: ${HARD_FLOOR_PCT}%. STOPPING — manual intervention required.`;
    console.error(msg);
    await createAlert('critical', msg).catch(() => {});
    state.alertSent = true;
    writeState(state);
    return;
  }

  console.log(`[GlobalMonitor] Attempt ${state.attemptCount}/${MAX_ATTEMPTS}: ${existingPicks.length} picks live (need ${MIN_PICKS_THRESHOLD}) — triggering generation for ${today}`);

  // Track global leagues being scanned
  state.globalLeaguesScanned = ALL_GLOBAL_LEAGUES;
  writeState(state);

  try {
    const success = await runGenerationFn(`global-monitor-attempt${state.attemptCount}`);

    if (success) {
      const freshPicks = await getPicksByDate(today).catch(() => []);
      state.picksLive = freshPicks.length;
      state.lastSuccessAt = now;
      console.log(`[GlobalMonitor] Attempt ${state.attemptCount} SUCCEEDED — ${freshPicks.length} picks now live for ${today}`);

      if (freshPicks.length < MIN_PICKS_THRESHOLD) {
        // Generation ran but still below threshold — count as failed attempt
        const msg = `[GlobalMonitor] Attempt ${state.attemptCount}: generation ran but only ${freshPicks.length}/${MIN_PICKS_THRESHOLD} picks meet the ${HARD_FLOOR_PCT}% floor. ${MAX_ATTEMPTS - state.attemptCount} attempts remaining.`;
        console.warn(msg);
        if (state.attemptCount >= MAX_ATTEMPTS) {
          state.killSwitchTriggered = true;
          state.killSwitchAt = now;
          await createAlert('critical', `⛔ KILL-SWITCH: ${msg} STOPPING.`).catch(() => {});
          state.alertSent = true;
        } else {
          await createAlert('warning', msg).catch(() => {});
        }
      }
    } else {
      const msg = `[GlobalMonitor] Attempt ${state.attemptCount}/${MAX_ATTEMPTS} FAILED for ${today}. ${MAX_ATTEMPTS - state.attemptCount} attempts remaining.`;
      console.error(msg);
      if (state.attemptCount >= MAX_ATTEMPTS) {
        state.killSwitchTriggered = true;
        state.killSwitchAt = now;
        await createAlert('critical', `⛔ KILL-SWITCH: ${msg} STOPPING.`).catch(() => {});
        state.alertSent = true;
      } else {
        await createAlert('warning', msg).catch(() => {});
      }
    }
  } catch (err: any) {
    const msg = `[GlobalMonitor] Attempt ${state.attemptCount} threw error: ${err.message}`;
    console.error(msg);
    if (state.attemptCount >= MAX_ATTEMPTS) {
      state.killSwitchTriggered = true;
      state.killSwitchAt = now;
      await createAlert('critical', `⛔ KILL-SWITCH: ${msg} STOPPING.`).catch(() => {});
      state.alertSent = true;
    }
  }

  writeState(state);
}

// ─── State Reader (for admin API) ────────────────────────────────────────────
export function getMonitorState(): LastUpdateState {
  return readState();
}

// ─── Reset State (for admin use) ─────────────────────────────────────────────
export function resetMonitorState(): void {
  const today = todayStr();
  writeState({ ...DEFAULT_STATE, date: today });
  console.log(`[GlobalMonitor] State reset for ${today}`);
}
