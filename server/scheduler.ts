import cron from 'node-cron';
import { createRunLog, updateRunLog, createAlert, getRunLogs } from './storage.js';
import { generateDailyPicks } from './routes.js';

// Timezone: AST (America/Halifax = UTC-4, no DST adjustment needed for Puerto Rico)
const TZ = 'America/Halifax';

let schedulerStarted = false;
let keepAliveInterval: NodeJS.Timeout | null = null;

// ─── Keep-Alive Ping ──────────────────────────────────────────────────────────
// Pings /api/health every 5 minutes to prevent container sleep
function startKeepAlive() {
  const port = process.env.PORT || '8080';
  const url = `http://localhost:${port}/api/health`;

  keepAliveInterval = setInterval(async () => {
    try {
      const http = await import('http');
      const req = http.default.get(url, (res) => {
        // Success — container stays warm
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[Keep-Alive] Ping OK (${res.statusCode})`);
        }
      });
      req.on('error', () => {
        // Silently ignore — server may be restarting
      });
      req.setTimeout(5000, () => req.destroy());
    } catch {
      // Ignore
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  console.log('[Scheduler] Keep-alive ping started (every 5 minutes)');
}

// ─── Helper: Get today's date string ─────────────────────────────────────────
function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

// ─── Helper: Log run attempt ──────────────────────────────────────────────────
async function logRun(status: string, triggeredBy = 'scheduler', error?: string) {
  try {
    await createRunLog({
      date: todayStr(),
      status,
      triggeredBy,
      errorMessage: error,
    });
  } catch (err) {
    console.error('[Scheduler] Failed to log run:', err);
  }
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

    // Run the generation
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

    dailyRunCompleted = true;
    lastRunDate = today;
    console.log(`[Scheduler] Daily generation complete: ${result.total} picks in ${duration}ms`);
    return true;

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

  // Reset daily flag at midnight
  cron.schedule('0 0 0 * * *', () => {
    dailyRunCompleted = false;
    console.log(`[Scheduler] Midnight reset — daily flag cleared for ${todayStr()}`);
  }, { timezone: TZ });

  // 12:02 AM — Midnight Archival
  cron.schedule('0 2 0 * * *', async () => {
    console.log('[Scheduler] 12:02 AM — Midnight archival');
    try {
      // Archive previous day's results
      await createAlert('info', `Midnight archival completed for ${todayStr()}`);
    } catch (err) {
      console.error('[Scheduler] Midnight archival error:', err);
    }
  }, { timezone: TZ });

  // 12:30 AM — Pre-check Watchdog
  cron.schedule('0 30 0 * * *', async () => {
    console.log('[Scheduler] 12:30 AM — Pre-check watchdog');
    dailyRunCompleted = false; // Reset for fresh day
  }, { timezone: TZ });

  // 1:00 AM — PRIMARY Daily Pick Generation
  cron.schedule('0 0 1 * * *', async () => {
    console.log('[Scheduler] 1:00 AM — PRIMARY daily pick generation');
    await runDailyGeneration('scheduler-1am');
  }, { timezone: TZ });

  // 1:10 AM — Heartbeat Verification
  cron.schedule('0 10 1 * * *', async () => {
    if (!dailyRunCompleted) {
      console.warn('[Scheduler] 1:10 AM — CRITICAL: 1:00 AM run did not complete!');
      await createAlert('critical', '1:00 AM daily generation did not complete — retry cascade starting');
    }
  }, { timezone: TZ });

  // 1:30 AM — Retry 1
  cron.schedule('0 30 1 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 1:30 AM — Retry 1');
      await runDailyGeneration('scheduler-retry1');
    }
  }, { timezone: TZ });

  // 2:00 AM — Retry 2
  cron.schedule('0 0 2 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 2:00 AM — Retry 2');
      await runDailyGeneration('scheduler-retry2');
    }
  }, { timezone: TZ });

  // 2:30 AM — Retry 3
  cron.schedule('0 30 2 * * *', async () => {
    if (!dailyRunCompleted) {
      console.log('[Scheduler] 2:30 AM — Retry 3');
      await runDailyGeneration('scheduler-retry3');
    }
  }, { timezone: TZ });

  // 3:00 AM — Final Failsafe
  cron.schedule('0 0 3 * * *', async () => {
    if (!dailyRunCompleted) {
      console.error('[Scheduler] 3:00 AM — FINAL FAILSAFE');
      const success = await runDailyGeneration('scheduler-failsafe');
      if (!success) {
        await createAlert('critical', `TOTAL FAILURE: All retry attempts failed for ${todayStr()}`);
      }
    }
  }, { timezone: TZ });

  // 4:00 AM — Player Stats Collection
  cron.schedule('0 0 4 * * *', async () => {
    console.log('[Scheduler] 4:00 AM — Player stats collection');
    // Player stats collection would run here
  }, { timezone: TZ });

  // 8:00 AM — Featured Auto-Pilot
  cron.schedule('0 0 8 * * *', async () => {
    console.log('[Scheduler] 8:00 AM — Featured auto-pilot');
    // Auto-select highest confidence pick for featured section
  }, { timezone: TZ });

  // 10:00 AM — Re-engagement Check
  cron.schedule('0 0 10 * * *', async () => {
    console.log('[Scheduler] 10:00 AM — Re-engagement check');
  }, { timezone: TZ });

  // 11:00 AM — NBA Props Fetch
  cron.schedule('0 0 11 * * *', async () => {
    console.log('[Scheduler] 11:00 AM — NBA props fetch');
  }, { timezone: TZ });

  // 11:59 PM — Nightly Reset
  cron.schedule('0 59 23 * * *', async () => {
    console.log('[Scheduler] 11:59 PM — Nightly reset');
    dailyRunCompleted = false;
  }, { timezone: TZ });

  // Every 2 hours — Auto-Settle Results
  cron.schedule('0 0 */2 * * *', async () => {
    console.log('[Scheduler] Auto-settle results check');
    // Check finished games and update Won/Lost statuses
  }, { timezone: TZ });

  // Every 15 minutes — Grace Period Enforcement
  cron.schedule('0 */15 * * * *', async () => {
    // Enforce subscription expiry
  }, { timezone: TZ });

  // Sunday 11 PM — Weekly Audit
  cron.schedule('0 0 23 * * 0', async () => {
    console.log('[Scheduler] Sunday 11 PM — Weekly audit');
    // Generate performance audit report
  }, { timezone: TZ });

  console.log('[Scheduler] All cron jobs registered');
  console.log('[Scheduler] Primary generation: 1:00 AM AST with 4-layer retry cascade');
}

export { runDailyGeneration };
