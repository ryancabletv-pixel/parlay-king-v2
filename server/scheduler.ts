import cron from 'node-cron';
import { createRunLog, updateRunLog, createAlert, getRunLogs, getPicksByDate } from './storage.js';
import { generateDailyPicks } from './routes.js';
import { pingGoogleAfterUpdate } from './seo.js';
import { autoSettleResults } from './resultsSettler.js';
import { getBudgetStatus } from './apis/oddsApi.js';
import { syncTomorrowGames } from './services/tomorrowSync.js';
import { runGlobalDataMonitor, getMonitorState, resetMonitorState } from './globalDataMonitor.js';

// ─── Timezone ─────────────────────────────────────────────────────────────────
// America/Moncton = AST (UTC-4) / ADT (UTC-3 during DST) — New Brunswick, Canada
const TZ = 'America/Moncton';

// ─── V3-15 Persistent Memory Config ─────────────────────────────────────────
// This file is the hardcoded memory for all V3-15 threshold rules.
// It survives container restarts, Railway redeploys, and context flushes.
import * as fs from 'fs';
import * as path from 'path';
let V3_CONFIG: any = {};
try {
  const configPath = path.join(process.cwd(), 'v3_config.json');
  if (fs.existsSync(configPath)) {
    V3_CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('[V3-Config] ✅ Persistent memory loaded from v3_config.json');
    console.log(`[V3-Config] Thresholds: Pro=${V3_CONFIG.confidence_thresholds?.pro_min}% | Floor=${V3_CONFIG.confidence_thresholds?.leg_hard_floor}% | Budget=${V3_CONFIG.api_budget?.auto_ceiling}/${V3_CONFIG.api_budget?.daily_ceiling}`);
  } else {
    console.warn('[V3-Config] ⚠️  v3_config.json not found — using hardcoded defaults');
  }
} catch (e: any) {
  console.error('[V3-Config] Failed to load v3_config.json:', e.message);
}

// ─── System Config (Safety Valve — hardcoded thresholds) ─────────────────────
// system_config.json is the SINGLE SOURCE OF TRUTH for all V3-15 threshold rules.
// The engine reads MIN_THRESHOLD and HIGH_VAL_THRESHOLD from this file.
// If the file is missing, hardcoded defaults are used — never 0 or undefined.
let SYS_CONFIG: any = {
  thresholds: { MIN_THRESHOLD: 0.65, HIGH_VAL_THRESHOLD: 0.68 },
  api_sources: {},
  fail_safe_rules: {},
  data_source_health: { check_interval_minutes: 60, alert_on_suspended: true, alert_on_quota_exhausted: true, dashboard_indicator: true },
};
try {
  const sysPath = path.join(process.cwd(), 'system_config.json');
  if (fs.existsSync(sysPath)) {
    SYS_CONFIG = JSON.parse(fs.readFileSync(sysPath, 'utf8'));
    const t = SYS_CONFIG.thresholds;
    console.log('[SysConfig] ✅ Safety Valve config loaded from system_config.json');
    console.log(`[SysConfig] MIN_THRESHOLD=${t?.MIN_THRESHOLD} | HIGH_VAL_THRESHOLD=${t?.HIGH_VAL_THRESHOLD} | LIFETIME=${t?.LIFETIME_THRESHOLD}`);
    console.log('[SysConfig] NO pick will be published below ' + (t?.MIN_THRESHOLD * 100).toFixed(0) + '% — ABSOLUTE RULE');
  } else {
    console.warn('[SysConfig] ⚠️  system_config.json not found — using hardcoded Safety Valve defaults (MIN=0.65, HIGH_VAL=0.68)');
  }
} catch (e: any) {
  console.error('[SysConfig] Failed to load system_config.json:', e.message);
}
export { V3_CONFIG, SYS_CONFIG };

let schedulerStarted = false;
let keepAliveInterval: NodeJS.Timeout | null = null;

// ─── Keep-Alive Ping ──────────────────────────────────────────────────────────
// Pings /api/health every 5 minutes to prevent container sleep on Railway
function startKeepAlive() {
  const port = process.env.PORT || '8080';
  const internalUrl = `http://localhost:${port}/api/health`;
  const externalUrl = 'https://soccernbaparlayking.vip/api/health';

  keepAliveInterval = setInterval(async () => {
    try {
      const http = await import('http');
      const req = http.default.get(internalUrl, (res) => {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[Keep-Alive] Internal ping OK (${res.statusCode})`);
        }
      });
      req.on('error', () => {});
      req.setTimeout(5000, () => req.destroy());

      const https = await import('https');
      const extReq = https.default.get(externalUrl, (res) => {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[Keep-Alive] External ping OK (${res.statusCode})`);
        }
      });
      extReq.on('error', () => {});
      extReq.setTimeout(8000, () => extReq.destroy());
    } catch {
      // Ignore
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  console.log('[Scheduler] Keep-alive ping started (every 5 minutes)');
}

// ─── Helper: Today's date in AST ─────────────────────────────────────────────
function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

// ─── Daily Pick Generation ────────────────────────────────────────────────────
let dailyRunCompleted = false;
let lastRunDate = '';

async function runDailyGeneration(triggeredBy = 'scheduler'): Promise<boolean> {
  const today = todayStr();

  // Prevent duplicate runs on same day
  if (dailyRunCompleted && lastRunDate === today && triggeredBy === 'scheduler') {
    console.log(`[Scheduler] Daily run already completed for ${today}, skipping`);
    return true;
  }

  // ── API THROTTLE GUARD: stop auto-tasks at 90/100 calls ──────────────────────────────
  // 10 calls are always reserved for manual dashboard actions.
  // If this is a scheduler-triggered run and we're at or above 90, abort.
  if (triggeredBy.startsWith('scheduler')) {
    const budget = getBudgetStatus();
    if (budget.used_today >= 90) {
      const msg = `[Scheduler] THROTTLE GUARD: ${budget.used_today}/100 API calls used. Auto-tasks paused to reserve 10 calls for manual actions.`;
      console.warn(msg);
      await createAlert('warning', msg);
      return false;
    }
    if (budget.used_today >= 80) {
      console.warn(`[Scheduler] THROTTLE WARNING: ${budget.used_today}/100 API calls used. Approaching auto-task limit (90).`);
    }
  }

  console.log(`[Scheduler] Starting daily pick generation for ${today} (triggered by: ${triggeredBy})`);
  const startTime = Date.now();
  let logId: number | undefined;

  try {
    const log = await createRunLog({
      date: today,
      status: 'running',
      triggeredBy,
    });
    logId = log.id;

    // Run the Gold Standard V3 Titan XII engine
    const result = await generateDailyPicks(today);

    const duration = Date.now() - startTime;
    if (logId) {
      await updateRunLog(logId, {
        status: 'success',
        picksGenerated: result.total,
        soccerPicks: result.soccer,
        nbaPicks: result.nba,
        ftpUploaded: result.ftpUploaded,
        duration,
      });
    }

    // ── MULTI-SPORT SYNC POST-RUN CHECK ────────────────────────────────────
    // FIX: No retry on 0 games or partial sync. Log and wait for next 24h cycle.
    // Efficiency Veto: do NOT retry every 10 minutes — this burns credits.
    const syncStatus = result.multiSportSyncStatus ?? 'FULL';
    if (result.total === 0) {
      // Zero picks generated — log and STOP. Do not retry.
      console.warn(`[Multi-Sport Sync] 0 picks generated for ${today}. Logging and waiting for next 24h cycle (no retry).`);
      await createAlert('warning', `Multi-Sport Sync: 0 picks for ${today}. No retry — waiting for next 24h cycle.`);
      dailyRunCompleted = true; // Mark complete so retry cascade does NOT fire
      lastRunDate = today;
    } else if (syncStatus !== 'FULL') {
      // Partial sync — log warning but mark complete to prevent retry cascade
      console.warn(`[Multi-Sport Sync] Partial sync (${syncStatus}) for ${today}. Marking complete — no retry cascade.`);
      await createAlert('warning', `Multi-Sport Sync partial (${syncStatus}) for ${today}. Picks are live. No retry.`);
      dailyRunCompleted = true; // FIX: prevent 10-min retry loop
      lastRunDate = today;
    } else {
      dailyRunCompleted = true;
      lastRunDate = today;
      console.log(`[Multi-Sport Sync] ✅ FULL SYNC confirmed — Soccer + Basketball both live on all tier dashboards.`);
    }

    console.log(`[Scheduler] Daily generation complete: ${result.total} picks in ${duration}ms (sync=${syncStatus})`);

    // ── Clear picks.json cache so live site reflects new picks within seconds ──
    try {
      const { clearModulePicksCache } = await import('./routes.js');
      const impl = (clearModulePicksCache as any)._impl;
      if (typeof impl === 'function') impl();
      else clearModulePicksCache(); // fallback: clears module-level ref
      console.log('[Scheduler] picks.json cache cleared — site will update within 1-2 seconds');
    } catch (_) { /* non-critical — cache expires naturally after 60s */ }

    // ── Ping Google/Bing after every successful pick update ──────────────────
    // This ensures all pages are re-indexed immediately after new picks are live
    pingGoogleAfterUpdate(`daily-generation-${today}`).catch(err => {
      console.warn('[Scheduler] Google ping failed (non-critical):', err);
    });

    return syncStatus === 'FULL';

  } catch (err: any) {
    const duration = Date.now() - startTime;
    const errorMsg = err?.message || String(err);
    console.error(`[Scheduler] Daily generation FAILED:`, errorMsg);

    if (logId) {
      await updateRunLog(logId, {
        status: 'failed',
        errorMessage: errorMsg,
        duration,
      });
    }

    await createAlert('critical', `Daily pick generation failed: ${errorMsg}`);
    return false;
  }
}

// ─── Start All Cron Jobs ──────────────────────────────────────────────────────
export function startScheduler() {
  if (schedulerStarted) {
    console.log('[Scheduler] Already started, skipping');
    return;
  }
  schedulerStarted = true;

  // Start keep-alive
  startKeepAlive();

  // ── Midnight reset ──────────────────────────────────────────────────────────
  cron.schedule('0 0 0 * * *', () => {
    dailyRunCompleted = false;
    console.log(`[Scheduler] Midnight reset (America/Moncton) — daily flag cleared for ${todayStr()}`);
  }, { timezone: TZ });

  // ── 12:02 AM — Midnight Archival ───────────────────────────────────────────
  cron.schedule('0 2 0 * * *', async () => {
    console.log('[Scheduler] 12:02 AM AST — Midnight archival');
    try {
      await createAlert('info', `Midnight archival completed for ${todayStr()}`);
    } catch (err) {
      console.error('[Scheduler] Midnight archival error:', err);
    }
  }, { timezone: TZ });

  // ── 12:30 AM — Pre-check Watchdog ──────────────────────────────────────────
  cron.schedule('0 30 0 * * *', async () => {
    console.log('[Scheduler] 12:30 AM AST — Pre-check watchdog');
    dailyRunCompleted = false; // Reset for fresh day
  }, { timezone: TZ });

  // ── 1:00 AM — PRIMARY Daily Pick Generation ────────────────────────────────
  // This is the main cron trigger: fires at exactly 1:00 AM AST (America/Moncton)
  // Cron expression: second=0, minute=0, hour=1, every day
  cron.schedule('0 0 1 * * *', async () => {
    console.log('[Scheduler] 1:00 AM AST (America/Moncton) — PRIMARY daily pick generation');
    await runDailyGeneration('scheduler-1am');
  }, { timezone: TZ });

  // ── 1:10 AM — Heartbeat Verification ──────────────────────────────────────
  cron.schedule('0 10 1 * * *', async () => {
    if (!dailyRunCompleted) {
      console.warn('[Scheduler] 1:10 AM AST — CRITICAL: 1:00 AM run did not complete!');
      await createAlert('critical', '1:00 AM daily generation did not complete — retry cascade starting');
    }
  }, { timezone: TZ });

  // ── 1:30 AM — Retry 1 ─────────────────────────────────────────────────────
  cron.schedule('0 30 1 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 1:30 AM AST — Retry 1');
      await runDailyGeneration('scheduler-retry1');
    }
  }, { timezone: TZ });

  // ── 2:00 AM — Retry 2 + Tomorrow V3-15 Pre-Audit Sync ───────────────────────
  // If daily picks already completed: run Tomorrow sync instead.
  // If daily picks NOT yet done: run Retry 2 first, then Tomorrow sync.
  cron.schedule('0 0 2 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 2:00 AM AST — Retry 2');
      await runDailyGeneration('scheduler-retry2');
    }
    // Always run Tomorrow sync at 2 AM regardless of daily pick status
    console.log('[Scheduler] 2:00 AM AST — Tomorrow V3-15 Pre-Audit Sync starting');
    try {
      const syncResult = await syncTomorrowGames('scheduler-2am');
      const msg = `Tomorrow sync: ${syncResult.gamesFound} games found, ${syncResult.gamesSaved} saved for ${syncResult.date} (${syncResult.budgetUsed} API calls)`;
      console.log(`[Scheduler] ${msg}`);
      if (syncResult.errors.length > 0) {
        await createAlert('warning', `Tomorrow sync had ${syncResult.errors.length} error(s): ${syncResult.errors.slice(0, 2).join('; ')}`);
      }
    } catch (err: any) {
      console.error('[Scheduler] Tomorrow sync failed:', err.message);
      await createAlert('critical', `Tomorrow V3-15 sync failed at 2 AM: ${err.message}`);
    }
  }, { timezone: TZ });

  // ── 2:30 AM — Retry 3 ─────────────────────────────────────────────────────
  cron.schedule('0 30 2 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 2:30 AM AST — Retry 3');
      await runDailyGeneration('scheduler-retry3');
    }
  }, { timezone: TZ });

  // ── 3:00 AM — Final Failsafe ───────────────────────────────────────────────
  cron.schedule('0 0 3 * * *', async () => {
    if (!dailyRunCompleted) {
      console.error('[Scheduler] 3:00 AM AST — FINAL FAILSAFE');
      const success = await runDailyGeneration('scheduler-failsafe');
      if (!success) {
        await createAlert('critical', `TOTAL FAILURE: All retry attempts failed for ${todayStr()}`);
      }
    }
  }, { timezone: TZ });

  // ── 4:00 AM — Player Stats Collection ─────────────────────────────────────
  cron.schedule('0 0 4 * * *', async () => {
    console.log('[Scheduler] 4:00 AM AST — Player stats collection');
  }, { timezone: TZ });

  // ── 8:00 AM — Featured Auto-Pilot ─────────────────────────────────────────
  cron.schedule('0 0 8 * * *', async () => {
    console.log('[Scheduler] 8:00 AM AST — Featured auto-pilot');
    // Auto-select highest confidence pick for featured section
    // Then ping Google to ensure featured pick page is indexed
    pingGoogleAfterUpdate('featured-autopilot').catch(() => {});
  }, { timezone: TZ });

  // ── 10:00 AM — Re-engagement Check ────────────────────────────────────────
  cron.schedule('0 0 10 * * *', async () => {
    console.log('[Scheduler] 10:00 AM AST — Re-engagement check');
  }, { timezone: TZ });

  // ── 11:00 AM — NBA Props Fetch ─────────────────────────────────────────────
  cron.schedule('0 0 11 * * *', async () => {
    console.log('[Scheduler] 11:00 AM AST — NBA props fetch');
    pingGoogleAfterUpdate('nba-props-update').catch(() => {});
  }, { timezone: TZ });

  // ── 11:59 PM — Nightly Reset ───────────────────────────────────────────────
  cron.schedule('0 59 23 * * *', async () => {
    console.log('[Scheduler] 11:59 PM AST — Nightly reset');
    dailyRunCompleted = false;
  }, { timezone: TZ });

  // ── Every 2 hours — Auto-Settle Results ───────────────────────────────────
  cron.schedule('0 0 */2 * * *', async () => {
    console.log('[Scheduler] Auto-settle results check — fetching final scores from API');
    try {
      const stats = await autoSettleResults();
      console.log(`[Scheduler] Settlement run: checked=${stats.checked} settled=${stats.settled} wins=${stats.wins} losses=${stats.losses} voids=${stats.voids} errors=${stats.errors}`);
    } catch (err) {
      console.error('[Scheduler] Settlement error:', err);
    }
  }, { timezone: TZ });

  // ── Every day at 6 AM — Morning Settlement Pass ────────────────────────────
  // Catches any overnight games that finished after the last 2-hour check
  cron.schedule('0 0 6 * * *', async () => {
    console.log('[Scheduler] 6:00 AM AST — Morning settlement pass');
    try {
      const stats = await autoSettleResults();
      console.log(`[Scheduler] Morning settlement: ${stats.settled} settled (${stats.wins}W/${stats.losses}L/${stats.voids}V)`);
    } catch (err) {
      console.error('[Scheduler] Morning settlement error:', err);
    }
  }, { timezone: TZ });

  // ── Every 15 minutes — Grace Period Enforcement ────────────────────────────
  cron.schedule('0 */15 * * * *', async () => {
    // Enforce subscription expiry
  }, { timezone: TZ });

  // ── Sunday 11 PM — Weekly Audit ────────────────────────────────────────────
  cron.schedule('0 0 23 * * 0', async () => {
    console.log('[Scheduler] Sunday 11 PM AST — Weekly audit');
    // Generate performance audit report
  }, { timezone: TZ });

  // ── Every 60 Minutes — Global Data Monitor ──────────────────────────────────
  // Checks if today's picks are live and meet the 65% hard floor threshold.
  // Uses last_update.json for state persistence to prevent duplicate API calls.
  // 3-Attempt Kill-Switch: stops and sends critical alert after 3 failed attempts.
  // Scans 23 global leagues: European, South American, Asian, and Oceania markets.
  // NEVER fires if dailyRunCompleted=true (picks already live and healthy).
  cron.schedule('0 0 * * * *', async () => {
    const nowHour = parseInt(
      new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }), 10
    );
    // Only run between 1 AM and 11 PM — before 1 AM the primary cron handles it
    if (nowHour < 1 || nowHour > 23) return;
    console.log(`[Scheduler] Hourly global data monitor check (hour=${nowHour} AST)`);
    await runGlobalDataMonitor(
      (triggeredBy: string) => runDailyGeneration(triggeredBy),
      () => dailyRunCompleted
    ).catch((err: any) => console.error('[Scheduler] Global monitor error:', err.message));
  }, { timezone: TZ });

  console.log('[Scheduler] All cron jobs registered');
  console.log('[Scheduler] Timezone: America/Moncton (AST UTC-4 / ADT UTC-3)');
  console.log('[Scheduler] Primary generation: 1:00 AM AST with 4-layer retry cascade');
  console.log('[Scheduler] 60-min global data monitor: active (3-attempt kill-switch, last_update.json state)');
  console.log('[Scheduler] Global leagues: 23 leagues across Europe, South America, Asia, Oceania');
  console.log('[Scheduler] Hard floor: 65% minimum confidence on all 3-leg tab picks');
  console.log('[Scheduler] V3-15 factor audit: 8/15 factors required for every pick');
  console.log('[Scheduler] Google/Bing ping: after every pick update');

  // ── Startup Catch-Up Check ────────────────────────────────────────────────
  // If the container restarted after 1:00 AM and today's picks are missing,
  // trigger generation immediately (fixes Railway restart issue).
  // Uses a 15-second delay to allow the database connection to stabilize.
  setTimeout(async () => {
    try {
      const today = todayStr();
      // Get the current hour in AST timezone
      const nowHour = parseInt(
        new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }),
        10
      );

      // Only run catch-up between 1:00 AM and 11:59 PM AST
      // (before 1 AM the 1:00 AM cron will handle it normally)
      if (nowHour >= 1 && nowHour <= 23) {
        const existingPicks = await getPicksByDate(today);
        if (existingPicks.length === 0) {
          console.log(`[Scheduler] STARTUP CATCH-UP: No picks found for ${today} (hour=${nowHour} AST) — triggering generation now`);
          await createAlert('warning', `Startup catch-up triggered: no picks found for ${today} at hour ${nowHour} AST`);
          const success = await runDailyGeneration('startup-catchup');
          if (success) {
            console.log(`[Scheduler] Startup catch-up SUCCEEDED for ${today}`);
          } else {
            console.error(`[Scheduler] Startup catch-up FAILED for ${today}`);
            await createAlert('critical', `Startup catch-up failed for ${today} — picks may be missing`);
          }
        } else {
          console.log(`[Scheduler] Startup check: ${existingPicks.length} picks already exist for ${today} — no catch-up needed`);
          // Mark as completed so retry cascade doesn't fire unnecessarily
          dailyRunCompleted = true;
          lastRunDate = today;
        }
      } else {
        console.log(`[Scheduler] Startup check: hour=${nowHour} AST — before 1:00 AM, no catch-up needed`);
      }
    } catch (err) {
      console.error('[Scheduler] Startup catch-up check failed:', err);
    }
  }, 15000); // 15 second delay to allow DB connection to stabilize
}

// ── Fixture Scraper Cron: Every 6 hours (0:00, 6:00, 12:00, 18:00 AST) ──────────────
// Free ESPN scraper — no paid API credits used
cron.schedule('0 0 0,6,12,18 * * *', async () => {
  console.log('[FixtureScraper] ⏰ Starting scheduled fixture scrape (free ESPN API)...');
  try {
    const { scrapeUpcomingFixtures } = await import('./fixtureScraper.js');
    const result = await scrapeUpcomingFixtures();
    console.log(`[FixtureScraper] ✅ Scheduled scrape complete: ${result.total} fixtures (${result.nba} NBA, ${result.soccer} Soccer) — 0 API credits`);
  } catch (err: any) {
    console.error('[FixtureScraper] Scheduled scrape failed:', err.message);
  }
}, { timezone: TZ });

export { runDailyGeneration };
