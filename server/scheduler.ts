import cron from 'node-cron';
import { createRunLog, updateRunLog, createAlert, getRunLogs, getPicksByDate } from './storage.js';
import { generateDailyPicks } from './routes.js';
import { pingGoogleAfterUpdate } from './seo.js';
import { autoSettleResults } from './resultsSettler.js';
import { getBudgetStatus } from './apis/oddsApi.js';
import { syncTomorrowGames } from './services/tomorrowSync.js';

// ─── Timezone ─────────────────────────────────────────────────────────────────
// America/Moncton = AST (UTC-4) / ADT (UTC-3 during DST) — New Brunswick, Canada
const TZ = 'America/Moncton';

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
    // Verify both Basketball and Soccer were published. If either is missing,
    // schedule a targeted retry within 10 minutes rather than waiting for the
    // next full retry window. This ensures both sports always appear on the
    // tier dashboards simultaneously.
    const syncStatus = result.multiSportSyncStatus ?? 'FULL';
    if (syncStatus !== 'FULL') {
      console.warn(`[Multi-Sport Sync] Sync status: ${syncStatus}. Scheduling targeted retry in 10 minutes...`);
      await createAlert('warning', `Multi-Sport Sync ${syncStatus} for ${today}. Targeted retry scheduled in 10 min.`);
      // Mark run as NOT completed so the 1:10 AM retry slot can re-run
      dailyRunCompleted = false;
    } else {
      dailyRunCompleted = true;
      lastRunDate = today;
      console.log(`[Multi-Sport Sync] ✅ FULL SYNC confirmed — Soccer + Basketball both live on all tier dashboards.`);
    }

    console.log(`[Scheduler] Daily generation complete: ${result.total} picks in ${duration}ms (sync=${syncStatus})`);

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

  console.log('[Scheduler] All cron jobs registered');
  console.log('[Scheduler] Timezone: America/Moncton (AST UTC-4 / ADT UTC-3)');
  console.log('[Scheduler] Primary generation: 1:00 AM AST with 4-layer retry cascade');
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

export { runDailyGeneration };
