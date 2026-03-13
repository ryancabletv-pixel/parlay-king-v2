/**
 * ESPN Free Scraper — Emergency Tier-3 Data Source
 * ─────────────────────────────────────────────────
 * Uses ESPN's public (no-key) scoreboard API to fetch game schedules.
 * This is the LAST RESORT fallback when both API-Football and The Odds API
 * are suspended/quota-exhausted. It requires NO API key and has NO rate limits.
 *
 * Architecture:
 *   Tier 1: API-Football (primary)
 *   Tier 2: The Odds API (fallback)
 *   Tier 3: ESPN Free Scraper ← THIS FILE (emergency)
 *   Tier 4: persistent_fixtures.json (offline cache)
 */

import * as fs from 'fs';
import * as path from 'path';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CACHE_PATH = path.join(process.cwd(), 'permanent_fixtures.json');
const COOLDOWN_PATH = path.join(process.cwd(), 'api_cooldowns.json');

// ─── ESPN League Map ──────────────────────────────────────────────────────────
// Maps ESPN league codes to human-readable names and sport types
const ESPN_LEAGUES = [
  // NBA
  { sport: 'basketball', league: 'nba',   name: 'NBA',            type: 'nba' },
  // Soccer — top 10 leagues
  { sport: 'soccer', league: 'eng.1',  name: 'Premier League',  type: 'soccer' },
  { sport: 'soccer', league: 'esp.1',  name: 'La Liga',         type: 'soccer' },
  { sport: 'soccer', league: 'ger.1',  name: 'Bundesliga',      type: 'soccer' },
  { sport: 'soccer', league: 'ita.1',  name: 'Serie A',         type: 'soccer' },
  { sport: 'soccer', league: 'fra.1',  name: 'Ligue 1',         type: 'soccer' },
  { sport: 'soccer', league: 'usa.1',  name: 'MLS',             type: 'soccer' },
  { sport: 'soccer', league: 'por.1',  name: 'Primeira Liga',   type: 'soccer' },
  { sport: 'soccer', league: 'ned.1',  name: 'Eredivisie',      type: 'soccer' },
  { sport: 'soccer', league: 'mex.1',  name: 'Liga MX',         type: 'soccer' },
  { sport: 'soccer', league: 'bra.1',  name: 'Brasileirao',     type: 'soccer' },
  { sport: 'soccer', league: 'tur.1',  name: 'Süper Lig',       type: 'soccer' },
  { sport: 'soccer', league: 'sco.1',  name: 'Scottish Prem',   type: 'soccer' },
  { sport: 'soccer', league: 'jpn.1',  name: 'J1 League',       type: 'soccer' },
  { sport: 'soccer', league: 'arg.1',  name: 'Primera División',type: 'soccer' },
];

// ─── Cooldown Manager ─────────────────────────────────────────────────────────
interface CooldownEntry {
  api: string;
  until: number;  // Unix timestamp ms
  reason: string;
}

export function loadCooldowns(): Record<string, CooldownEntry> {
  try {
    if (fs.existsSync(COOLDOWN_PATH)) {
      return JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

export function saveCooldowns(cooldowns: Record<string, CooldownEntry>): void {
  try {
    fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cooldowns, null, 2));
  } catch (_) {}
}

export function isInCooldown(apiName: string): boolean {
  const cooldowns = loadCooldowns();
  const entry = cooldowns[apiName];
  if (!entry) return false;
  if (Date.now() > entry.until) {
    // Cooldown expired — remove it
    delete cooldowns[apiName];
    saveCooldowns(cooldowns);
    return false;
  }
  const minutesLeft = Math.ceil((entry.until - Date.now()) / 60000);
  console.log(`[Cooldown] ${apiName} is in cooldown for ${minutesLeft} more minutes (reason: ${entry.reason})`);
  return true;
}

export function setCooldown(apiName: string, minutes: number, reason: string): void {
  const cooldowns = loadCooldowns();
  cooldowns[apiName] = {
    api: apiName,
    until: Date.now() + minutes * 60 * 1000,
    reason,
  };
  saveCooldowns(cooldowns);
  console.log(`[Cooldown] ⏸️  ${apiName} put in cooldown for ${minutes} minutes — ${reason}`);
}

export function getCooldownStatus(): Record<string, { active: boolean; minutesLeft?: number; reason?: string }> {
  const cooldowns = loadCooldowns();
  const now = Date.now();
  const result: Record<string, { active: boolean; minutesLeft?: number; reason?: string }> = {};
  for (const [api, entry] of Object.entries(cooldowns)) {
    if (now > entry.until) {
      result[api] = { active: false };
    } else {
      result[api] = {
        active: true,
        minutesLeft: Math.ceil((entry.until - now) / 60000),
        reason: entry.reason,
      };
    }
  }
  return result;
}

// ─── ESPN Fixture Fetcher ─────────────────────────────────────────────────────
export interface EspnFixture {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  league: string;
  leagueCode: string;
  sport: string;
  date: string;        // ISO string
  dateLocal: string;   // YYYY-MM-DD in local time
  status: string;      // 'scheduled' | 'in_progress' | 'final'
  homeScore?: number;
  awayScore?: number;
  venue?: string;
  source: 'espn-free-scraper';
}

async function fetchEspnLeague(
  sport: string,
  league: string,
  leagueName: string,
  type: string,
  dateStr: string  // YYYYMMDD format
): Promise<EspnFixture[]> {
  const url = `${ESPN_BASE}/${sport}/${league}/scoreboard?dates=${dateStr}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[ESPN] HTTP ${res.status} for ${leagueName}`);
      return [];
    }

    const data: any = await res.json();
    const events: any[] = data.events || [];

    return events.map((event: any) => {
      const comp = event.competitions?.[0] || {};
      const competitors: any[] = comp.competitors || [];
      const home = competitors.find((c: any) => c.homeAway === 'home') || competitors[0] || {};
      const away = competitors.find((c: any) => c.homeAway === 'away') || competitors[1] || {};
      const statusType = comp.status?.type?.name || 'STATUS_SCHEDULED';
      const dateISO = event.date || comp.date || '';
      // Convert to YYYY-MM-DD local date (ADT = UTC-3)
      const dateObj = dateISO ? new Date(dateISO) : new Date();
      const dateLocal = dateObj.toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });

      return {
        id: `espn-${event.id || Math.random().toString(36).slice(2)}`,
        homeTeam: home.team?.displayName || home.team?.name || 'Home Team',
        awayTeam: away.team?.displayName || away.team?.name || 'Away Team',
        homeTeamAbbr: home.team?.abbreviation || '',
        awayTeamAbbr: away.team?.abbreviation || '',
        league: leagueName,
        leagueCode: league,
        sport: type,
        date: dateISO,
        dateLocal,
        status: statusType.includes('FINAL') ? 'final'
               : statusType.includes('IN_PROGRESS') ? 'in_progress'
               : 'scheduled',
        homeScore: home.score ? parseInt(home.score) : undefined,
        awayScore: away.score ? parseInt(away.score) : undefined,
        venue: comp.venue?.fullName,
        source: 'espn-free-scraper',
      } as EspnFixture;
    });
  } catch (err: any) {
    console.log(`[ESPN] Error fetching ${leagueName}: ${err.message}`);
    return [];
  }
}

// ─── Main ESPN Scraper Entry Point ────────────────────────────────────────────
export async function fetchEspnFixtures(dateStr?: string): Promise<{
  fixtures: EspnFixture[];
  totalCount: number;
  leagueBreakdown: Record<string, number>;
  source: 'espn-free-scraper';
  cached: boolean;
  dateQueried: string;
}> {
  // Convert YYYY-MM-DD to YYYYMMDD for ESPN API
  const targetDate = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  const espnDate = targetDate.replace(/-/g, '');

  console.log(`[ESPN] 🆓 Emergency scraper activated — fetching ${ESPN_LEAGUES.length} leagues for ${targetDate}`);

  const allFixtures: EspnFixture[] = [];
  const leagueBreakdown: Record<string, number> = {};

  // Fetch all leagues in parallel (ESPN has no rate limit)
  const results = await Promise.allSettled(
    ESPN_LEAGUES.map(({ sport, league, name, type }) =>
      fetchEspnLeague(sport, league, name, type, espnDate)
    )
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { name } = ESPN_LEAGUES[i];
    if (result.status === 'fulfilled' && result.value.length > 0) {
      allFixtures.push(...result.value);
      leagueBreakdown[name] = result.value.length;
    }
  }

  console.log(`[ESPN] ✅ Total fixtures fetched: ${allFixtures.length} across ${Object.keys(leagueBreakdown).length} leagues`);
  for (const [league, count] of Object.entries(leagueBreakdown)) {
    console.log(`[ESPN]   ${league}: ${count} games`);
  }

  // Save to persistent cache if we got data
  if (allFixtures.length > 0) {
    savePermanentCache(allFixtures, targetDate);
  }

  return {
    fixtures: allFixtures,
    totalCount: allFixtures.length,
    leagueBreakdown,
    source: 'espn-free-scraper',
    cached: false,
    dateQueried: targetDate,
  };
}

// ─── Persistent Cache ─────────────────────────────────────────────────────────
interface PermanentCache {
  lastUpdated: string;
  dateQueried: string;
  fixtures: EspnFixture[];
  totalCount: number;
  leagueBreakdown: Record<string, number>;
}

export function savePermanentCache(fixtures: EspnFixture[], dateQueried: string): void {
  try {
    const cache: PermanentCache = {
      lastUpdated: new Date().toISOString(),
      dateQueried,
      fixtures,
      totalCount: fixtures.length,
      leagueBreakdown: fixtures.reduce((acc, f) => {
        acc[f.league] = (acc[f.league] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    console.log(`[ESPN] 💾 Saved ${fixtures.length} fixtures to permanent_fixtures.json`);
  } catch (err: any) {
    console.error('[ESPN] Failed to save permanent cache:', err.message);
  }
}

export function loadPermanentCache(): {
  fixtures: EspnFixture[];
  totalCount: number;
  leagueBreakdown: Record<string, number>;
  source: 'espn-free-scraper';
  cached: true;
  lastUpdated?: string;
  dateQueried?: string;
} | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const cache: PermanentCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!cache.fixtures || cache.fixtures.length === 0) return null;
    console.log(`[ESPN] 📂 Loaded ${cache.fixtures.length} fixtures from permanent_fixtures.json (last updated: ${cache.lastUpdated})`);
    return {
      fixtures: cache.fixtures,
      totalCount: cache.fixtures.length,
      leagueBreakdown: cache.leagueBreakdown || {},
      source: 'espn-free-scraper',
      cached: true,
      lastUpdated: cache.lastUpdated,
      dateQueried: cache.dateQueried,
    };
  } catch (err: any) {
    console.error('[ESPN] Failed to load permanent cache:', err.message);
    return null;
  }
}

// ─── Convert ESPN Fixtures to V3 Engine Format ────────────────────────────────
// Converts ESPN fixture format to the same format as API-Football fixtures
// so the V3-15 engine can process them without modification.
export function convertEspnToV3Format(fixture: EspnFixture): any {
  return {
    fixture: {
      id: fixture.id,
      date: fixture.date,
      status: { short: fixture.status === 'final' ? 'FT' : fixture.status === 'in_progress' ? 'LIVE' : 'NS' },
      venue: { name: fixture.venue || 'Unknown Venue', city: '' },
    },
    league: {
      id: 0,
      name: fixture.league,
      country: '',
      logo: '',
      flag: '',
      season: new Date().getFullYear(),
      round: '',
    },
    teams: {
      home: {
        id: 0,
        name: fixture.homeTeam,
        logo: '',
        winner: fixture.homeScore !== undefined && fixture.awayScore !== undefined
          ? fixture.homeScore > fixture.awayScore : null,
      },
      away: {
        id: 0,
        name: fixture.awayTeam,
        logo: '',
        winner: fixture.homeScore !== undefined && fixture.awayScore !== undefined
          ? fixture.awayScore > fixture.homeScore : null,
      },
    },
    goals: {
      home: fixture.homeScore ?? null,
      away: fixture.awayScore ?? null,
    },
    score: {
      halftime: { home: null, away: null },
      fulltime: { home: fixture.homeScore ?? null, away: fixture.awayScore ?? null },
    },
    // ESPN-specific metadata
    _espnSource: true,
    _sport: fixture.sport,
    _leagueCode: fixture.leagueCode,
    _dateLocal: fixture.dateLocal,
  };
}

export default {
  fetchEspnFixtures,
  loadPermanentCache,
  savePermanentCache,
  convertEspnToV3Format,
  isInCooldown,
  setCooldown,
  getCooldownStatus,
};
