/**
 * fixtureScraper.ts
 * Free fixture scraper — uses ESPN's public JSON APIs (no API key, no credits)
 * Scrapes NBA + Soccer fixtures for the next 72 hours and saves to upcoming_fixtures table.
 *
 * ESPN public endpoints (no auth required):
 *   NBA:    https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD
 *   Soccer: https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard?dates=YYYYMMDD
 *
 * Runs on a cron schedule (every 6 hours) — no paid API credits used.
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// ESPN soccer league slugs (free, no auth)
const ESPN_SOCCER_LEAGUES = [
  { slug: 'eng.1',   name: 'English Premier League' },
  { slug: 'esp.1',   name: 'La Liga' },
  { slug: 'ger.1',   name: 'Bundesliga' },
  { slug: 'ita.1',   name: 'Serie A' },
  { slug: 'fra.1',   name: 'Ligue 1' },
  { slug: 'ned.1',   name: 'Eredivisie' },
  { slug: 'por.1',   name: 'Primeira Liga' },
  { slug: 'tur.1',   name: 'Süper Lig' },
  { slug: 'uefa.champions', name: 'UEFA Champions League' },
  { slug: 'uefa.europa',    name: 'UEFA Europa League' },
  { slug: 'usa.1',   name: 'MLS' },
  { slug: 'mex.1',   name: 'Liga MX' },
  { slug: 'bra.1',   name: 'Brasileirão' },
  { slug: 'arg.1',   name: 'Argentine Primera' },
  { slug: 'jpn.1',   name: 'J1 League' },
  { slug: 'kor.1',   name: 'K League 1' },
  { slug: 'aus.1',   name: 'A-League' },
];

function formatDateESPN(date: Date): string {
  // ESPN uses YYYYMMDD format
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function getDatesToScrape(): Date[] {
  const dates: Date[] = [];
  const now = new Date();
  for (let i = 0; i <= 3; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

async function fetchESPN(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ParlayKingBot/1.0)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function scrapeNBA(dates: Date[]): Promise<number> {
  let saved = 0;
  for (const date of dates) {
    const dateStr = formatDateESPN(date);
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
    const data = await fetchESPN(url);
    if (!data?.events) continue;

    for (const event of data.events) {
      try {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const teams = comp.competitors || [];
        const home = teams.find((t: any) => t.homeAway === 'home');
        const away = teams.find((t: any) => t.homeAway === 'away');
        if (!home || !away) continue;

        const homeTeam = home.team?.displayName || home.team?.name;
        const awayTeam = away.team?.displayName || away.team?.name;
        const gameDate = event.date ? new Date(event.date) : date;
        const status = comp.status?.type?.name?.toLowerCase() || 'scheduled';

        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO upcoming_fixtures
              (sport, league, home_team, away_team, game_date, game_time, game_datetime, source, external_id, status, raw_data)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (sport, home_team, away_team, game_date) DO UPDATE SET
              status = EXCLUDED.status,
              game_datetime = EXCLUDED.game_datetime,
              raw_data = EXCLUDED.raw_data,
              updated_at = NOW()
          `, [
            'nba', 'NBA', homeTeam, awayTeam,
            gameDate.toISOString().slice(0, 10),
            gameDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET',
            gameDate.toISOString(),
            'espn', event.id, status,
            JSON.stringify({ espnId: event.id, name: event.name, shortName: event.shortName }),
          ]);
          saved++;
        } finally {
          client.release();
        }
      } catch {
        // Skip individual game errors
      }
    }
    await delay(250); // polite delay between NBA date requests
  }
  return saved;
}

async function scrapeSoccer(dates: Date[]): Promise<number> {
  let saved = 0;
  for (const league of ESPN_SOCCER_LEAGUES) {
    for (const date of dates) {
      const dateStr = formatDateESPN(date);
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.slug}/scoreboard?dates=${dateStr}`;
      const data = await fetchESPN(url);
      if (!data?.events) continue;

      for (const event of data.events) {
        try {
          const comp = event.competitions?.[0];
          if (!comp) continue;
          const teams = comp.competitors || [];
          const home = teams.find((t: any) => t.homeAway === 'home');
          const away = teams.find((t: any) => t.homeAway === 'away');
          if (!home || !away) continue;

          const homeTeam = home.team?.displayName || home.team?.name;
          const awayTeam = away.team?.displayName || away.team?.name;
          const gameDate = event.date ? new Date(event.date) : date;
          const status = comp.status?.type?.name?.toLowerCase() || 'scheduled';

          const client = await pool.connect();
          try {
            await client.query(`
              INSERT INTO upcoming_fixtures
                (sport, league, home_team, away_team, game_date, game_time, game_datetime, source, external_id, status, raw_data)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              ON CONFLICT (sport, home_team, away_team, game_date) DO UPDATE SET
                status = EXCLUDED.status,
                game_datetime = EXCLUDED.game_datetime,
                raw_data = EXCLUDED.raw_data,
                updated_at = NOW()
            `, [
              'soccer', league.name, homeTeam, awayTeam,
              gameDate.toISOString().slice(0, 10),
              gameDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET',
              gameDate.toISOString(),
              'espn', event.id, status,
              JSON.stringify({ espnId: event.id, league: league.name, slug: league.slug }),
            ]);
            saved++;
          } finally {
            client.release();
          }
        } catch {
          // Skip individual game errors
        }
      }
    }
    await delay(300); // polite delay between leagues
  }
  return saved;
}

/**
 * Main scrape function — called by scheduler every 6 hours
 * Returns summary of what was scraped
 */
export async function scrapeUpcomingFixtures(): Promise<{
  nba: number;
  soccer: number;
  total: number;
  dates: string[];
}> {
  const dates = getDatesToScrape();
  const dateStrs = dates.map(d => d.toISOString().slice(0, 10));
  console.log(`[FixtureScraper] Scraping fixtures for dates: ${dateStrs.join(', ')}`);

  const [nbaCount, soccerCount] = await Promise.all([
    scrapeNBA(dates),
    scrapeSoccer(dates),
  ]);

  const total = nbaCount + soccerCount;
  console.log(`[FixtureScraper] ✅ Scraped ${total} fixtures (${nbaCount} NBA, ${soccerCount} Soccer) — 0 API credits used`);
  return { nba: nbaCount, soccer: soccerCount, total, dates: dateStrs };
}

/**
 * Save V3-15 analysis result to the cache column on upcoming_fixtures
 */
export async function cacheAnalysisResult(
  fixtureId: number,
  result: {
    confidence: number;
    pass: boolean;
    bestPick: string;
    factors: Record<string, any>;
    reasoning: string;
    blockedBy?: string[];
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE upcoming_fixtures SET
        analyzed = TRUE,
        analysis_result = $1,
        analysis_score = $2,
        analysis_pass = $3,
        analyzed_at = NOW(),
        updated_at = NOW()
      WHERE id = $4
    `, [JSON.stringify(result), result.confidence, result.pass, fixtureId]);
  } finally {
    client.release();
  }
}

/**
 * Get upcoming fixtures for a date range from the DB
 */
export async function getUpcomingFixtures(
  fromDate: string,
  toDate: string,
  sport?: string
): Promise<any[]> {
  const client = await pool.connect();
  try {
    const params: any[] = [fromDate, toDate];
    let sportClause = '';
    if (sport && sport !== 'all') {
      params.push(sport);
      sportClause = `AND sport = $${params.length}`;
    }
    const result = await client.query(`
      SELECT id, sport, league, home_team, away_team, game_date, game_time, game_datetime,
             status, analyzed, analysis_result, analysis_score, analysis_pass, analyzed_at, source
      FROM upcoming_fixtures
      WHERE game_date BETWEEN $1 AND $2
        AND status NOT IN ('final', 'post')
        ${sportClause}
      ORDER BY game_datetime ASC NULLS LAST, game_date ASC, sport ASC
      LIMIT 200
    `, params);
    return result.rows;
  } finally {
    client.release();
  }
}
