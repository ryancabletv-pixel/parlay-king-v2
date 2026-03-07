import { FixtureData } from '../goldStandardV2.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_KEY = process.env.API_FOOTBALL_KEY || '';
const BASE_URL = 'https://v3.football.api-sports.io';

// ─── Cache Configuration ──────────────────────────────────────────────────────
// All API responses are cached to disk for 1 hour to protect the 100 req/day quota.
// Cache lives in /tmp/parlay-king-cache/ so it persists across restarts but clears on reboot.
const CACHE_DIR = path.join(os.tmpdir(), 'parlay-king-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheKey(endpoint: string): string {
  // Sanitize endpoint to a safe filename
  return endpoint.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) + '.json';
}

function readCache(cacheKey: string): any | null {
  try {
    const filePath = path.join(CACHE_DIR, cacheKey);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const { timestamp, data } = JSON.parse(raw);
    const age = Date.now() - timestamp;

    if (age > CACHE_TTL_MS) {
      console.log(`[Cache] EXPIRED (${Math.round(age / 60000)}min old): ${cacheKey}`);
      fs.unlinkSync(filePath);
      return null;
    }

    console.log(`[Cache] HIT (${Math.round(age / 60000)}min old): ${cacheKey}`);
    return data;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, data: any): void {
  try {
    ensureCacheDir();
    const filePath = path.join(CACHE_DIR, cacheKey);
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), data }), 'utf8');
    console.log(`[Cache] STORED: ${cacheKey}`);
  } catch (err) {
    console.warn('[Cache] Failed to write cache:', err);
  }
}

// ─── Cached API Fetch ─────────────────────────────────────────────────────────
async function apiFetch(endpoint: string): Promise<any> {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY not configured');

  const cacheKey = getCacheKey(endpoint);
  const cached = readCache(cacheKey);
  if (cached !== null) return cached;

  console.log(`[API-Football] LIVE REQUEST: ${endpoint}`);
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'x-apisports-key': API_KEY,
      'x-rapidapi-key': API_KEY,
    },
  });

  if (!res.ok) throw new Error(`API-Football error: ${res.status} ${res.statusText}`);
  const data = await res.json();

  // Cache the response
  writeCache(cacheKey, data);
  return data;
}

// ─── Cache Management ─────────────────────────────────────────────────────────
export function clearApiCache(): void {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
      console.log(`[Cache] Cleared ${files.length} cached responses`);
    }
  } catch (err) {
    console.warn('[Cache] Failed to clear cache:', err);
  }
}

export function getCacheStatus(): { files: number; totalSizeKB: number; entries: { key: string; ageMin: number; expiresMin: number }[] } {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    let totalSize = 0;
    const entries = files.map(f => {
      const filePath = path.join(CACHE_DIR, f);
      const stat = fs.statSync(filePath);
      totalSize += stat.size;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const { timestamp } = JSON.parse(raw);
        const ageMs = Date.now() - timestamp;
        return { key: f, ageMin: Math.round(ageMs / 60000), expiresMin: Math.round((CACHE_TTL_MS - ageMs) / 60000) };
      } catch {
        return { key: f, ageMin: -1, expiresMin: -1 };
      }
    });
    return { files: files.length, totalSizeKB: Math.round(totalSize / 1024), entries };
  } catch {
    return { files: 0, totalSizeKB: 0, entries: [] };
  }
}

// ─── Target Leagues ───────────────────────────────────────────────────────────
const TARGET_LEAGUES = [
  39,   // Premier League
  140,  // La Liga
  135,  // Serie A
  78,   // Bundesliga
  61,   // Ligue 1
  2,    // Champions League
  3,    // Europa League
  253,  // MLS
  307,  // Saudi Pro League
];

export async function fetchTodayFixtures(date: string): Promise<FixtureData[]> {
  console.log(`[API-Football] Fetching fixtures for ${date}`);

  const fixtures: FixtureData[] = [];

  try {
    const data = await apiFetch(`/fixtures?date=${date}&timezone=America/Halifax`);
    const rawFixtures = data.response || [];

    for (const f of rawFixtures) {
      if (!TARGET_LEAGUES.includes(f.league?.id)) continue;
      if (f.fixture?.status?.short !== 'NS') continue;

      const fixture: FixtureData = {
        fixtureId: f.fixture.id,
        homeTeam: f.teams?.home?.name || 'Home',
        awayTeam: f.teams?.away?.name || 'Away',
        league: f.league?.name || 'Unknown',
        sport: 'soccer',
        date,
      };

      try {
        const [oddsData, statsData] = await Promise.allSettled([
          fetchOdds(f.fixture.id),
          fetchTeamStats(f.teams?.home?.id, f.teams?.away?.id, f.league?.id, f.league?.season),
        ]);

        if (oddsData.status === 'fulfilled') Object.assign(fixture, oddsData.value);
        if (statsData.status === 'fulfilled') Object.assign(fixture, statsData.value);
      } catch (err) {
        console.warn(`[API-Football] Failed to fetch extra data for fixture ${f.fixture.id}`);
      }

      fixtures.push(fixture);
    }

    console.log(`[API-Football] Found ${fixtures.length} qualifying fixtures`);
  } catch (err) {
    console.error('[API-Football] Fetch failed:', err);
    throw err;
  }

  return fixtures;
}

async function fetchOdds(fixtureId: number): Promise<Partial<FixtureData>> {
  try {
    const data = await apiFetch(`/odds?fixture=${fixtureId}&bookmaker=8`);
    const bookmakers = data.response?.[0]?.bookmakers || [];
    if (!bookmakers.length) return {};

    const markets = bookmakers[0]?.bets || [];
    const matchWinner = markets.find((m: any) => m.name === 'Match Winner');
    if (!matchWinner) return {};

    const home = matchWinner.values?.find((v: any) => v.value === 'Home')?.odd;
    const draw = matchWinner.values?.find((v: any) => v.value === 'Draw')?.odd;
    const away = matchWinner.values?.find((v: any) => v.value === 'Away')?.odd;

    return {
      homeOdds: home ? parseFloat(home) : undefined,
      drawOdds: draw ? parseFloat(draw) : undefined,
      awayOdds: away ? parseFloat(away) : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchTeamStats(homeId: number, awayId: number, leagueId: number, season: number): Promise<Partial<FixtureData>> {
  try {
    const [homeStats, awayStats] = await Promise.allSettled([
      apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`),
      apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`),
    ]);

    const result: Partial<FixtureData> = {};

    if (homeStats.status === 'fulfilled') {
      const s = homeStats.value.response;
      const played = s?.fixtures?.played?.home || 1;
      const wins = s?.fixtures?.wins?.home || 0;
      result.homeWinRate = wins / played;
      result.homeGoalDiff = (s?.goals?.for?.total?.home || 0) - (s?.goals?.against?.total?.home || 0);
    }

    if (awayStats.status === 'fulfilled') {
      const s = awayStats.value.response;
      const played = s?.fixtures?.played?.away || 1;
      const wins = s?.fixtures?.wins?.away || 0;
      result.awayWinRate = wins / played;
      result.awayGoalDiff = (s?.goals?.for?.total?.away || 0) - (s?.goals?.against?.total?.away || 0);
    }

    return result;
  } catch {
    return {};
  }
}
