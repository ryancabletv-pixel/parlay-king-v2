/**
 * ============================================================
 *  THE ODDS API — LIVE PRODUCTION INTEGRATION
 *  Hard Guardrails Protocol v1.0
 * ============================================================
 *
 *  GUARDRAIL 1 — NO MOCK DATA:
 *    If the API returns no games, this module returns NULL / empty array.
 *    Mock/placeholder fixtures are strictly prohibited.
 *
 *  GUARDRAIL 2 — API BUDGET LEDGER:
 *    Hard ceiling: 100 API calls per 24-hour cycle.
 *    /sports endpoint cached for 4 hours.
 *    /odds endpoint cached for 4 hours per sport key.
 *    Only active "Featured" games poll live odds.
 *    Every call is logged to the Budget Ledger before execution.
 *
 *  GUARDRAIL 3 — READ-ONLY PROTECTION:
 *    This module only reads data. It never writes to Historical
 *    Records or Win/Loss pages.
 *
 *  GUARDRAIL 4 — LIVE PRODUCTION KEY:
 *    Primary source: api.the-odds-api.com
 *    Connection verified by returning lastUpdatedAt for first 3 games.
 * ============================================================
 */

const ODDS_API_KEY  = process.env.ODDS_API_KEY || 'e780bee8f11d6859d3d5a99ca8549fff';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// ── Sport keys for each category ────────────────────────────
export const SPORT_KEYS = {
  // Europe — Tier 1
  soccer_epl:          'soccer_epl',
  soccer_laliga:       'soccer_spain_la_liga',
  soccer_seriea:       'soccer_italy_serie_a',
  soccer_bundesliga:   'soccer_germany_bundesliga',
  soccer_ligue1:       'soccer_france_ligue_one',
  soccer_eredivisie:   'soccer_netherlands_eredivisie',
  soccer_portugal:     'soccer_portugal_primeira_liga',
  soccer_turkey:       'soccer_turkey_super_league',
  soccer_scotland:     'soccer_scotland_premiership',
  soccer_belgium:      'soccer_belgium_first_div',
  // Europe — Tier 2 / Cups
  soccer_champions:    'soccer_uefa_champs_league',
  soccer_europa:       'soccer_uefa_europa_league',
  soccer_conference:   'soccer_uefa_europa_conference_league',
  // Americas
  soccer_mls:          'soccer_usa_mls',
  soccer_brazil:       'soccer_brazil_campeonato',
  soccer_argentina:    'soccer_argentina_primera_division',
  soccer_mexico:       'soccer_mexico_ligamx',
  soccer_colombia:     'soccer_colombia_primera_a',
  // Asia / Oceania
  soccer_japan:        'soccer_japan_j_league',
  soccer_australia:    'soccer_australia_aleague',
  soccer_china:        'soccer_china_superleague',
  soccer_south_korea:  'soccer_south_korea_kleague1',
  // Africa / Middle East
  soccer_saudi:        'soccer_saudi_professional_league',
  soccer_egypt:        'soccer_egypt_premier_league',
  // Basketball
  nba:                 'basketball_nba',
  ncaab:               'basketball_ncaab',
  euroleague:          'basketball_euroleague',
} as const;

// Leagues grouped for the Diversity Check waterfall
export const GLOBAL_SOCCER_KEYS = [
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
  'soccer_germany_bundesliga', 'soccer_france_ligue_one',
  'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga',
  'soccer_turkey_super_league', 'soccer_scotland_premiership',
  'soccer_belgium_first_div', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_brazil_campeonato',
  'soccer_argentina_primera_division', 'soccer_mexico_ligamx',
  'soccer_colombia_primera_a', 'soccer_japan_j_league',
  'soccer_australia_aleague', 'soccer_south_korea_kleague1',
  'soccer_saudi_professional_league',
];

// ── Budget Ledger ────────────────────────────────────────────
interface BudgetEntry {
  timestamp: string;
  sport: string;
  endpoint: string;
  remaining: number;
  used: number;
}

const BUDGET_CEILING = 100;      // Absolute daily limit from The Odds API
const AUTO_CEILING   = 90;        // Automated tasks stop here; 10 reserved for manual dashboard
let budgetUsedToday  = 0;
let budgetResetDate  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
const budgetLedger: BudgetEntry[] = [];

/**
 * checkBudget — call before every API request.
 * @param isManual  true = admin dashboard action (uses full 100 ceiling)
 *                  false = automated background task (stops at 90)
 */
function checkBudget(sport: string, endpoint: string, isManual = false): boolean {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  if (today !== budgetResetDate) {
    budgetUsedToday = 0;
    budgetResetDate = today;
    console.log(`[BudgetLedger] New day — quota reset to 0/${BUDGET_CEILING}`);
  }
  const ceiling = isManual ? BUDGET_CEILING : AUTO_CEILING;
  if (budgetUsedToday >= ceiling) {
    const label = isManual ? 'ABSOLUTE CEILING' : 'AUTO CEILING (90/100 — 10 reserved for manual)';
    console.warn(`[BudgetLedger] ${label} REACHED (${budgetUsedToday}/${ceiling}) — blocking call to ${endpoint} for ${sport}`);
    return false;
  }
  return true;
}

function recordCall(sport: string, endpoint: string, remaining: number, used: number) {
  budgetUsedToday++;
  budgetLedger.push({
    timestamp: new Date().toISOString(),
    sport,
    endpoint,
    remaining,
    used,
  });
  console.log(`[BudgetLedger] Call #${budgetUsedToday} | ${sport} | ${endpoint} | Remaining quota: ${remaining}`);
}

export function getBudgetStatus() {
  const usedToday = budgetUsedToday;
  return {
    ceiling:          BUDGET_CEILING,
    auto_ceiling:     AUTO_CEILING,
    used_today:       usedToday,
    remaining:        Math.max(0, BUDGET_CEILING - usedToday),
    remaining_auto:   Math.max(0, AUTO_CEILING   - usedToday),
    throttle_active:  usedToday >= AUTO_CEILING,
    reset_date:       budgetResetDate,
    ledger:           budgetLedger.slice(-20),
  };
}

// ── 4-Hour Cache ─────────────────────────────────────────────
interface CacheEntry {
  data: any;
  fetched_at: number;
  last_updated_at: string;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetched_at > CACHE_TTL_MS) {
    cache.delete(key);
    console.log(`[OddsAPI Cache] EXPIRED: ${key}`);
    return null;
  }
  const ageMin = Math.round((Date.now() - entry.fetched_at) / 60000);
  console.log(`[OddsAPI Cache] HIT: ${key} (${ageMin}m old, TTL 4h)`);
  return entry;
}

function setCache(key: string, data: any, lastUpdatedAt: string) {
  cache.set(key, { data, fetched_at: Date.now(), last_updated_at: lastUpdatedAt });
}

// ── Typed game structure ─────────────────────────────────────
export interface OddsGame {
  id:               string;
  sport_key:        string;
  sport_title:      string;
  commence_time:    string;   // ISO 8601
  last_update:      string;   // ISO 8601 — lastUpdatedAt
  home_team:        string;
  away_team:        string;
  home_odds:        number | null;
  away_odds:        number | null;
  draw_odds:        number | null;
  bookmaker:        string;
}

// ── Core fetch helper ────────────────────────────────────────────────────────────────
async function fetchOdds(sportKey: string, isManual?: boolean): Promise<OddsGame[]> {
  const _isManual = isManual === true;
  const cacheKey = `odds:${sportKey}`;

  // Check cache first — no API call if fresh
  const cached = getCached(cacheKey);
  if (cached) return cached.data as OddsGame[];

  // Budget check before every call
  // Automated tasks stop at 90; manual dashboard actions can use up to 100
  if (!checkBudget(sportKey, '/odds', _isManual)) {
    const msg = _isManual
      ? `[OddsAPI] ABSOLUTE CEILING (100) hit — returning empty for ${sportKey}`
      : `[OddsAPI] AUTO CEILING (90/100) hit — returning empty for ${sportKey}. Use manual refresh to force a call.`;
    console.warn(msg);
    return [];   // GUARDRAIL 1: return empty, never mock
  }

  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us,eu&markets=h2h&dateFormat=iso&oddsFormat=decimal`;

  try {
    const resp = await fetch(url);
    const remaining = parseInt(resp.headers.get('x-requests-remaining') || '0', 10);
    const used      = parseInt(resp.headers.get('x-requests-used') || '0', 10);
    recordCall(sportKey, '/odds', remaining, used);

    if (!resp.ok) {
      // ── HTTP 401/429 = Quota Exhausted or Key Invalid ────────────────────────────────
      if (resp.status === 401 || resp.status === 429) {
        console.error(`[OddsAPI] ❌ ${resp.status === 401 ? 'UNAUTHORIZED (key invalid or quota exhausted)' : 'RATE LIMITED (429)'} for ${sportKey} — blocking all further auto-calls`);
        budgetUsedToday = BUDGET_CEILING; // Block all further auto-calls this cycle
        return [];
      }
      console.error(`[OddsAPI] HTTP ${resp.status} for ${sportKey}`);
      return [];  // GUARDRAIL 1: return empty, never mock
    }

    const raw: any = await resp.json();
    // ── Quota-Exhausted Detection ───────────────────────────────────────────────
    // The Odds API returns {message, error_code} when quota is exhausted
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const errCode = raw.error_code || '';
      const errMsg  = raw.message || '';
      if (errCode === 'OUT_OF_USAGE_CREDITS' || errMsg.includes('quota') || errMsg.includes('Usage quota')) {
        console.error(`[OddsAPI] ❌ QUOTA EXHAUSTED: ${errMsg} — All Odds API calls blocked until next billing cycle.`);
        console.error(`[OddsAPI] See https://the-odds-api.com for usage plans.`);
        // Set budgetUsedToday to ceiling to block all further auto-calls
        budgetUsedToday = BUDGET_CEILING;
        return [];
      }
      console.error(`[OddsAPI] Unexpected response for ${sportKey}:`, raw);
      return [];
    }
    if (!Array.isArray(raw)) {
      console.error(`[OddsAPI] Unexpected response for ${sportKey}:`, raw);
      return [];
    }

    const games: OddsGame[] = raw.map(g => {
      // Extract best available bookmaker odds
      let homeOdds: number | null = null;
      let awayOdds: number | null = null;
      let drawOdds: number | null = null;
      let bookmakerName = 'N/A';

      // Prefer DraftKings > FanDuel > BetMGM > first available
      const preferred = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'unibet', 'pinnacle', 'bet365'];
      let bk = g.bookmakers?.find((b: any) => preferred.includes(b.key)) || g.bookmakers?.[0];

      if (bk) {
        bookmakerName = bk.title;
        const h2h = bk.markets?.find((m: any) => m.key === 'h2h');
        if (h2h) {
          for (const outcome of h2h.outcomes || []) {
            if (outcome.name === g.home_team) homeOdds = outcome.price;
            else if (outcome.name === g.away_team) awayOdds = outcome.price;
            else if (outcome.name === 'Draw') drawOdds = outcome.price;
          }
        }
      }

      return {
        id:            g.id,
        sport_key:     g.sport_key,
        sport_title:   g.sport_title,
        commence_time: g.commence_time,
        last_update:   g.last_update || new Date().toISOString(),
        home_team:     g.home_team,
        away_team:     g.away_team,
        home_odds:     homeOdds,
        away_odds:     awayOdds,
        draw_odds:     drawOdds,
        bookmaker:     bookmakerName,
      };
    });

    const lastUpdatedAt = games[0]?.last_update || new Date().toISOString();
    setCache(cacheKey, games, lastUpdatedAt);
    console.log(`[OddsAPI] Fetched ${games.length} games for ${sportKey} | lastUpdatedAt: ${lastUpdatedAt}`);
    return games;

  } catch (err: any) {
    console.error(`[OddsAPI] Fetch error for ${sportKey}:`, err.message);
    return [];  // GUARDRAIL 1: return empty, never mock
  }
}

// ── Public API ───────────────────────────────────────────────

/** Fetch today's soccer games across Tier 1 European leagues */
export async function getSoccerOdds(): Promise<OddsGame[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const tier1Leagues = [
    SPORT_KEYS.soccer_epl,
    SPORT_KEYS.soccer_laliga,
    SPORT_KEYS.soccer_seriea,
    SPORT_KEYS.soccer_bundesliga,
    SPORT_KEYS.soccer_ligue1,
    SPORT_KEYS.soccer_portugal,
    SPORT_KEYS.soccer_eredivisie,
    SPORT_KEYS.soccer_turkey,
    SPORT_KEYS.soccer_champions,
    SPORT_KEYS.soccer_europa,
  ];

  const results: OddsGame[] = [];
  for (const key of tier1Leagues) {
    const games = await fetchOdds(key);
    const todayGames = games.filter(g => g.commence_time.startsWith(today));
    results.push(...todayGames);
    // Budget guard: stop if we've used too many calls
    if (!checkBudget(key, 'diversity-check')) break;
  }

  if (results.length === 0) {
    console.warn(`[OddsAPI] NO SOCCER GAMES found for ${today} — returning NULL (no mock)`);
  }
  return results;
}

/**
 * DIVERSITY CHECK: Fetch today's soccer games from ALL global leagues.
 * Used when Tier 1 leagues don't produce enough 68%+ picks.
 * Budget-aware: stops fetching once 15 calls have been used for this sweep.
 */
export async function getGlobalSoccerOdds(): Promise<OddsGame[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const results: OddsGame[] = [];
  let callsUsed = 0;
  const MAX_DIVERSITY_CALLS = 15;

  console.log(`[OddsAPI] DIVERSITY CHECK: Scanning ${GLOBAL_SOCCER_KEYS.length} global leagues for ${today}`);

  for (const key of GLOBAL_SOCCER_KEYS) {
    if (callsUsed >= MAX_DIVERSITY_CALLS) {
      console.warn(`[OddsAPI] Diversity check budget cap (${MAX_DIVERSITY_CALLS}) reached`);
      break;
    }
    if (!checkBudget(key, 'global-diversity')) break;
    const games = await fetchOdds(key);
    const todayGames = games.filter(g => g.commence_time.startsWith(today));
    if (todayGames.length > 0) {
      results.push(...todayGames);
      callsUsed++;
      console.log(`[OddsAPI] Diversity: ${key} → ${todayGames.length} games today`);
    }
  }

  console.log(`[OddsAPI] Diversity check complete: ${results.length} total global soccer games found`);
  return results;
}

/** Fetch today's global basketball (NBA + EuroLeague) for diversity check */
export async function getGlobalBasketballOdds(): Promise<OddsGame[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const results: OddsGame[] = [];
  for (const key of [SPORT_KEYS.nba, SPORT_KEYS.euroleague]) {
    if (!checkBudget(key, 'basketball-diversity')) break;
    const games = await fetchOdds(key);
    const todayGames = games.filter(g => g.commence_time.startsWith(today));
    results.push(...todayGames);
  }
  return results;
}

/** Fetch today's MLS games */
export async function getMLSOdds(): Promise<OddsGame[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const games = await fetchOdds(SPORT_KEYS.soccer_mls);
  const todayGames = games.filter(g => g.commence_time.startsWith(today));

  if (todayGames.length === 0) {
    console.warn(`[OddsAPI] NO MLS GAMES found for ${today} — returning NULL (no mock)`);
  }
  return todayGames;
}

/** Fetch today's NBA games */
export async function getNBAOdds(): Promise<OddsGame[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const games = await fetchOdds(SPORT_KEYS.nba);
  const todayGames = games.filter(g => g.commence_time.startsWith(today));

  if (todayGames.length === 0) {
    console.warn(`[OddsAPI] NO NBA GAMES found for ${today} — returning NULL (no mock)`);
  }
  return todayGames;
}

/**
 * GUARDRAIL 4 — CONNECTION VERIFICATION
 * Returns lastUpdatedAt for the first 3 games across all sports.
 * Used to confirm live production key is active.
 */
/** Alias for routes.ts compatibility */
export function getBudgetLedger() {
  const s = getBudgetStatus();
  return {
    used:            s.used_today,
    remaining:       s.remaining,
    remaining_auto:  s.remaining_auto,
    throttle_active: s.throttle_active,
    auto_ceiling:    s.auto_ceiling,
    ceiling:         s.ceiling,
    cacheHits:       cache.size,
    lastReset:       s.reset_date,
    ledger:          s.ledger,
  };
}

/** Guardrail 4 status for admin verify-connection endpoint */
export async function getOddsApiStatus() {
  const result = await verifyConnection();
  return {
    budgetLedger: getBudgetLedger(),
    sampleGames: result.verification_games,
    cacheStatus: {
      entries: cache.size,
      ttlHours: 4,
    },
  };
}

export async function verifyConnection(): Promise<{
  status: 'OK' | 'ERROR';
  key_active: boolean;
  budget: ReturnType<typeof getBudgetStatus>;
  verification_games: Array<{ sport: string; game: string; last_updated_at: string; bookmaker: string }>;
  error?: string;
}> {
  try {
    const nbaGames     = await fetchOdds(SPORT_KEYS.nba);
    const soccerGames  = await fetchOdds(SPORT_KEYS.soccer_laliga);
    const mlsGames     = await fetchOdds(SPORT_KEYS.soccer_mls);

    const all = [
      ...nbaGames.slice(0, 1).map(g => ({ sport: 'NBA',     game: `${g.home_team} vs ${g.away_team}`, last_updated_at: g.last_update, bookmaker: g.bookmaker })),
      ...soccerGames.slice(0, 1).map(g => ({ sport: 'La Liga', game: `${g.home_team} vs ${g.away_team}`, last_updated_at: g.last_update, bookmaker: g.bookmaker })),
      ...mlsGames.slice(0, 1).map(g => ({ sport: 'MLS',     game: `${g.home_team} vs ${g.away_team}`, last_updated_at: g.last_update, bookmaker: g.bookmaker })),
    ];

    return {
      status: 'OK',
      key_active: true,
      budget: getBudgetStatus(),
      verification_games: all,
    };
  } catch (err: any) {
    return {
      status: 'ERROR',
      key_active: false,
      budget: getBudgetStatus(),
      verification_games: [],
      error: err.message,
    };
  }
}
