/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  TOMORROW SYNC — V3-15 Nightly Pre-Audit Pipeline                         ║
 * ║                                                                            ║
 * ║  Runs at 2:00 AM AST via Railway cron (scheduler.ts).                     ║
 * ║  1. Calculates "Tomorrow" in Atlantic Standard Time (America/Moncton)     ║
 * ║  2. Fetches NBA + Soccer odds for the next 24-48 hours via The Odds API   ║
 * ║  3. Runs each game through the V3-15 Gemini Two-Tier engine               ║
 * ║  4. Upserts results into pending_validator table (game_id conflict key)   ║
 * ║                                                                            ║
 * ║  Budget guard: stops at 80/100 API calls to protect the 1 AM daily run.  ║
 * ║  Table is auto-created on first run (CREATE TABLE IF NOT EXISTS).         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getBudgetStatus } from '../apis/oddsApi.js';

const TZ = 'America/Moncton';
const ODDS_API_KEY  = process.env.ODDS_API_KEY  || 'e780bee8f11d6859d3d5a99ca8549fff';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const FLASH_MODEL = 'gemini-2.0-flash';

// Sports to audit for tomorrow (matches user's script exactly)
const TOMORROW_SPORTS = [
  { key: 'basketball_nba',              sport: 'nba',    label: 'NBA' },
  { key: 'soccer_usa_mls',              sport: 'mls',    label: 'MLS' },
  { key: 'soccer_uefa_champs_league',   sport: 'soccer', label: 'UEFA Champions League' },
  { key: 'soccer_epl',                  sport: 'soccer', label: 'Premier League' },
  { key: 'soccer_spain_la_liga',        sport: 'soccer', label: 'La Liga' },
  { key: 'soccer_italy_serie_a',        sport: 'soccer', label: 'Serie A' },
  { key: 'soccer_germany_bundesliga',   sport: 'soccer', label: 'Bundesliga' },
  { key: 'soccer_france_ligue_one',     sport: 'soccer', label: 'Ligue 1' },
];

// ─── DB helpers ───────────────────────────────────────────────────────────────
function getPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10000,
  });
}

/** Auto-create pending_validator table if it doesn't exist */
async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_validator (
      id              SERIAL PRIMARY KEY,
      game_id         TEXT NOT NULL UNIQUE,
      date            TEXT NOT NULL,
      sport           TEXT NOT NULL,
      league          TEXT,
      home_team       TEXT NOT NULL,
      away_team       TEXT NOT NULL,
      commence_time   TEXT,
      home_odds       REAL,
      away_odds       REAL,
      draw_odds       REAL,
      bookmaker       TEXT,
      confidence      REAL NOT NULL DEFAULT 0,
      best_pick       TEXT,
      reasoning       TEXT,
      factors         JSONB,
      outcomes        JSONB,
      status          TEXT NOT NULL DEFAULT 'pending',
      approved        BOOLEAN NOT NULL DEFAULT false,
      pushed_to_live  BOOLEAN NOT NULL DEFAULT false,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pv_date   ON pending_validator (date);
    CREATE INDEX IF NOT EXISTS idx_pv_sport  ON pending_validator (sport);
    CREATE INDEX IF NOT EXISTS idx_pv_conf   ON pending_validator (confidence DESC);
  `);
}

/** Upsert a single audit row */
async function upsertValidatorRow(pool: Pool, row: {
  game_id: string; date: string; sport: string; league: string;
  home_team: string; away_team: string; commence_time: string;
  home_odds: number | null; away_odds: number | null; draw_odds: number | null;
  bookmaker: string; confidence: number; best_pick: string;
  reasoning: string; factors: Record<string, number>; outcomes: { label: string; conf: number }[];
}): Promise<void> {
  await pool.query(`
    INSERT INTO pending_validator
      (game_id, date, sport, league, home_team, away_team, commence_time,
       home_odds, away_odds, draw_odds, bookmaker,
       confidence, best_pick, reasoning, factors, outcomes,
       status, approved, pushed_to_live, synced_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            'pending', false, false, NOW(), NOW())
    ON CONFLICT (game_id) DO UPDATE SET
      confidence     = EXCLUDED.confidence,
      best_pick      = EXCLUDED.best_pick,
      reasoning      = EXCLUDED.reasoning,
      factors        = EXCLUDED.factors,
      outcomes       = EXCLUDED.outcomes,
      updated_at     = NOW()
  `, [
    row.game_id, row.date, row.sport, row.league,
    row.home_team, row.away_team, row.commence_time,
    row.home_odds, row.away_odds, row.draw_odds, row.bookmaker,
    row.confidence, row.best_pick, row.reasoning,
    JSON.stringify(row.factors), JSON.stringify(row.outcomes),
  ]);
}

// ─── Odds API fetch (direct, with commenceTimeFrom/To params) ─────────────────
interface RawGame {
  id: string; sport_key: string; sport_title: string;
  commence_time: string; home_team: string; away_team: string;
  bookmakers?: any[];
}

async function fetchTomorrowOdds(sportKey: string, dateStr: string): Promise<RawGame[]> {
  const from = `${dateStr}T00:00:00Z`;
  const to   = `${dateStr}T23:59:59Z`;
  const url  = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us,eu&markets=h2h&dateFormat=iso&oddsFormat=decimal&commenceTimeFrom=${from}&commenceTimeTo=${to}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[TomorrowSync] HTTP ${resp.status} for ${sportKey}`);
      return [];
    }
    const raw = await resp.json();
    return Array.isArray(raw) ? raw : [];
  } catch (err: any) {
    console.error(`[TomorrowSync] Fetch error for ${sportKey}:`, err.message);
    return [];
  }
}

function extractOdds(g: RawGame): { homeOdds: number | null; awayOdds: number | null; drawOdds: number | null; bookmaker: string } {
  const preferred = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'unibet', 'pinnacle', 'bet365'];
  const bk = g.bookmakers?.find(b => preferred.includes(b.key)) || g.bookmakers?.[0];
  if (!bk) return { homeOdds: null, awayOdds: null, drawOdds: null, bookmaker: 'N/A' };
  const h2h = bk.markets?.find((m: any) => m.key === 'h2h');
  let homeOdds: number | null = null, awayOdds: number | null = null, drawOdds: number | null = null;
  for (const o of h2h?.outcomes || []) {
    if (o.name === g.home_team) homeOdds = o.price;
    else if (o.name === g.away_team) awayOdds = o.price;
    else if (o.name === 'Draw') drawOdds = o.price;
  }
  return { homeOdds, awayOdds, drawOdds, bookmaker: bk.title };
}

// ─── V3-15 Gemini Audit (batch, matches user's script pattern) ────────────────
interface AuditItem {
  game_id: string;
  confidence_score: number;
  best_pick: string;
  v3_reasoning: string;
  factors: Record<string, number>;
  outcomes: { label: string; conf: number }[];
}

async function runGeminiAudit(games: RawGame[], sport: string, dateStr: string): Promise<AuditItem[]> {
  if (!genAI || games.length === 0) {
    // Deterministic fallback: use implied odds probability
    return games.map(g => {
      const { homeOdds, awayOdds } = extractOdds(g);
      const homeImpl = homeOdds ? 1 / homeOdds : 0.5;
      const awayImpl = awayOdds ? 1 / awayOdds : 0.5;
      const total = homeImpl + awayImpl;
      const homeConf = (homeImpl / total) * 100;
      const awayConf = (awayImpl / total) * 100;
      const bestConf = Math.max(homeConf, awayConf);
      const bestPick = homeConf >= awayConf ? `${g.home_team} Win` : `${g.away_team} Win`;
      return {
        game_id: g.id,
        confidence_score: Math.round(bestConf * 10) / 10,
        best_pick: bestPick,
        v3_reasoning: `Deterministic fallback (no Gemini key) — implied odds: ${g.home_team} ${homeConf.toFixed(1)}% / ${g.away_team} ${awayConf.toFixed(1)}%`,
        factors: {
          f01_marketConsensus_home: Math.round(homeImpl / total * 100) / 100,
          f01_marketConsensus_away: Math.round(awayImpl / total * 100) / 100,
          gemini_model: 0,
        },
        outcomes: [
          { label: `${g.home_team} Win`, conf: Math.round(homeConf * 10) / 10 },
          { label: `${g.away_team} Win`, conf: Math.round(awayConf * 10) / 10 },
        ],
      };
    });
  }

  const model = genAI.getGenerativeModel({ model: FLASH_MODEL });
  const results: AuditItem[] = [];

  // Batch in groups of 10 (matches existing Flash batch size)
  const BATCH_SIZE = 10;
  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const batch = games.slice(i, i + BATCH_SIZE);
    const gamesPayload = batch.map(g => {
      const { homeOdds, awayOdds, drawOdds } = extractOdds(g);
      return {
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        league: g.sport_title,
        commence_time: g.commence_time,
        home_odds: homeOdds,
        away_odds: awayOdds,
        draw_odds: drawOdds,
      };
    });

    const prompt = `You are the Gold Standard V3-15 Factor Audit Engine.
Perform a V3-15 Factor Audit on these ${sport} games for ${dateStr}.
Apply all 15 factors including:
  F01 Market Consensus (from odds)
  F02 Momentum
  F03 Team Quality
  F04 Head-to-Head History
  F05 Market Steam
  F06 Rest/Fatigue
  F07 Injuries/Absences
  F08 Travel Stress
  F09 Referee Bias
  F10 Environmental
  F11 League Standing
  F12 Venue Pressure
  F13 Advanced Market Steam (multi-book)
  F14 Altitude/Surface/Travel
  F15 Referee Official Tendencies

For each game return a confidence score (0-100) for the BEST pick only.
Minimum threshold to be useful: 60%.

Return ONLY a valid JSON array. No markdown, no explanation.
Schema per item:
{
  "game_id": "<string>",
  "confidence_score": <number 0-100>,
  "best_pick": "<Home Team Win | Away Team Win | Draw | Over 2.5 | Under 2.5>",
  "v3_reasoning": "<one sentence max>",
  "f01_market": <0-1>,
  "f02_momentum": <0-1>,
  "f03_quality": <0-1>,
  "f04_h2h": <0-1>,
  "f05_steam": <0-1>,
  "f06_rest": <0-1>,
  "f07_injuries": <0-1>,
  "f08_travel": <0-1>,
  "f09_referee": <0-1>,
  "f10_env": <0-1>,
  "f11_standing": <0-1>,
  "f12_venue": <0-1>,
  "f13_adv_steam": <0-1>,
  "f14_altitude": <0-1>,
  "f15_official": <0-1>
}

Games: ${JSON.stringify(gamesPayload)}`;

    try {
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();
      // Strip markdown code fences if present
      text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed: any[] = JSON.parse(text);
      for (const item of parsed) {
        const g = batch.find(x => x.id === item.game_id);
        if (!g) continue;
        const { homeOdds, awayOdds, drawOdds } = extractOdds(g);
        const outcomes: { label: string; conf: number }[] = [];
        const conf = item.confidence_score ?? 0;
        outcomes.push({ label: item.best_pick || `${g.home_team} Win`, conf });
        results.push({
          game_id: item.game_id,
          confidence_score: Math.round(conf * 10) / 10,
          best_pick: item.best_pick || `${g.home_team} Win`,
          v3_reasoning: item.v3_reasoning || '',
          factors: {
            f01_marketConsensus: item.f01_market ?? 0.5,
            f02_momentum:        item.f02_momentum ?? 0.5,
            f03_quality:         item.f03_quality ?? 0.5,
            f04_h2h:             item.f04_h2h ?? 0.5,
            f05_steam:           item.f05_steam ?? 0.5,
            f06_rest:            item.f06_rest ?? 0.5,
            f07_injuries:        item.f07_injuries ?? 0.5,
            f08_travel:          item.f08_travel ?? 0.5,
            f09_referee:         item.f09_referee ?? 0.5,
            f10_environmental:   item.f10_env ?? 0.5,
            f11_standing:        item.f11_standing ?? 0.5,
            f12_venue:           item.f12_venue ?? 0.5,
            f13_advSteam:        item.f13_adv_steam ?? 0.5,
            f14_altitude:        item.f14_altitude ?? 0.5,
            f15_official:        item.f15_official ?? 0.5,
            gemini_model:        1,
          },
          outcomes,
        });
      }
    } catch (err: any) {
      console.error(`[TomorrowSync] Gemini parse error for batch ${i}-${i + BATCH_SIZE}:`, err.message);
      // Fallback: add deterministic results for this batch
      for (const g of batch) {
        const { homeOdds, awayOdds } = extractOdds(g);
        const homeImpl = homeOdds ? 1 / homeOdds : 0.5;
        const awayImpl = awayOdds ? 1 / awayOdds : 0.5;
        const total = homeImpl + awayImpl;
        const homeConf = (homeImpl / total) * 100;
        const awayConf = (awayImpl / total) * 100;
        const bestConf = Math.max(homeConf, awayConf);
        const bestPick = homeConf >= awayConf ? `${g.home_team} Win` : `${g.away_team} Win`;
        results.push({
          game_id: g.id,
          confidence_score: Math.round(bestConf * 10) / 10,
          best_pick: bestPick,
          v3_reasoning: `Fallback (Gemini parse error) — implied odds`,
          factors: {
            f01_marketConsensus: Math.round(homeImpl / total * 100) / 100,
            gemini_model: 0,
          },
          outcomes: [
            { label: `${g.home_team} Win`, conf: Math.round(homeConf * 10) / 10 },
            { label: `${g.away_team} Win`, conf: Math.round(awayConf * 10) / 10 },
          ],
        });
      }
    }
  }
  return results;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
export interface TomorrowSyncResult {
  date: string;
  sportsProcessed: number;
  gamesFound: number;
  gamesAudited: number;
  gamesSaved: number;
  errors: string[];
  budgetUsed: number;
}

export async function syncTomorrowGames(triggeredBy = 'scheduler'): Promise<TomorrowSyncResult> {
  // ── Calculate tomorrow in AST ──────────────────────────────────────────────
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const dateStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

  console.log(`\n[TomorrowSync] ════════════════════════════════════════════`);
  console.log(`[TomorrowSync] V3-15 Nightly Pre-Audit — Target date: ${dateStr}`);
  console.log(`[TomorrowSync] Triggered by: ${triggeredBy}`);

  const result: TomorrowSyncResult = {
    date: dateStr,
    sportsProcessed: 0,
    gamesFound: 0,
    gamesAudited: 0,
    gamesSaved: 0,
    errors: [],
    budgetUsed: 0,
  };

  // ── Budget guard: stop at 80 to protect 1 AM daily run ────────────────────
  const budgetBefore = getBudgetStatus();
  if (budgetBefore.used_today >= 80) {
    const msg = `[TomorrowSync] BUDGET GUARD: ${budgetBefore.used_today}/100 calls used — aborting sync to protect 1 AM daily run`;
    console.warn(msg);
    result.errors.push(msg);
    return result;
  }

  const pool = getPool();
  try {
    // ── Ensure table exists ──────────────────────────────────────────────────
    await ensureTable(pool);
    console.log('[TomorrowSync] pending_validator table ready');

    // ── Process each sport ───────────────────────────────────────────────────
    for (const { key, sport, label } of TOMORROW_SPORTS) {
      // Re-check budget before each sport
      const budget = getBudgetStatus();
      if (budget.used_today >= 80) {
        console.warn(`[TomorrowSync] Budget cap reached (${budget.used_today}/100) — stopping after ${result.sportsProcessed} sports`);
        break;
      }

      console.log(`\n[TomorrowSync] Fetching ${label} (${key}) for ${dateStr}...`);
      const rawGames = await fetchTomorrowOdds(key, dateStr);
      result.sportsProcessed++;

      if (rawGames.length === 0) {
        console.log(`[TomorrowSync] No ${label} games found for ${dateStr} — skipping`);
        continue;
      }

      console.log(`[TomorrowSync] Found ${rawGames.length} ${label} games — running V3-15 audit...`);
      result.gamesFound += rawGames.length;

      // ── Run Gemini V3-15 audit ─────────────────────────────────────────────
      const auditResults = await runGeminiAudit(rawGames, sport, dateStr);
      result.gamesAudited += auditResults.length;

      // ── Upsert into pending_validator ──────────────────────────────────────
      for (const audit of auditResults) {
        const g = rawGames.find(x => x.id === audit.game_id);
        if (!g) continue;
        const { homeOdds, awayOdds, drawOdds, bookmaker } = extractOdds(g);
        try {
          await upsertValidatorRow(pool, {
            game_id:       g.id,
            date:          dateStr,
            sport,
            league:        g.sport_title,
            home_team:     g.home_team,
            away_team:     g.away_team,
            commence_time: g.commence_time,
            home_odds:     homeOdds,
            away_odds:     awayOdds,
            draw_odds:     drawOdds,
            bookmaker,
            confidence:    audit.confidence_score,
            best_pick:     audit.best_pick,
            reasoning:     audit.v3_reasoning,
            factors:       audit.factors,
            outcomes:      audit.outcomes,
          });
          result.gamesSaved++;
        } catch (err: any) {
          result.errors.push(`Upsert error for ${g.home_team} vs ${g.away_team}: ${err.message}`);
        }
      }
      console.log(`[TomorrowSync] ${label}: ${auditResults.length} audited, ${result.gamesSaved} saved`);
    }

    const budgetAfter = getBudgetStatus();
    result.budgetUsed = budgetAfter.used_today - budgetBefore.used_today;

    console.log(`\n[TomorrowSync] ════════════════════════════════════════════`);
    console.log(`[TomorrowSync] COMPLETE: ${result.gamesFound} found | ${result.gamesAudited} audited | ${result.gamesSaved} saved`);
    console.log(`[TomorrowSync] API calls used: ${result.budgetUsed} | Total today: ${budgetAfter.used_today}/100`);
    if (result.errors.length > 0) {
      console.warn(`[TomorrowSync] ${result.errors.length} errors:`, result.errors);
    }
  } finally {
    await pool.end();
  }

  return result;
}
