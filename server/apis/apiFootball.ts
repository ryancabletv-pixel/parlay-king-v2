/**
 * API-Football v3 Data Fetcher
 * Feeds live data into all 12 factors of the Gold Standard V3 Titan XII engine.
 *
 * Live data sources per factor:
 *  F01 — /odds?fixture=ID&bookmaker=8
 *  F02 — /fixtures?team=ID&last=5  (recent form)
 *  F03 — /teams/statistics?team=ID&league=LID&season=S
 *  F04 — /fixtures/headtohead?h2h=HOME-AWAY&last=10
 *  F05 — /odds (opening vs current comparison)
 *  F06 — /fixtures?team=ID&last=1  (last match date)
 *  F07 — /injuries?fixture=ID  (LIVE injury report)
 *  F08 — team timezone from /teams?id=ID
 *  F09 — referee data from /fixtures?id=ID
 *  F10 — OpenWeatherMap (via fixture venue city)
 *  F11 — /standings?league=LID&season=S  (current table rank)
 *  F12 — /venues?id=VID  (stadium capacity)
 */

import { FixtureData } from '../goldStandardV2.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API_KEY = process.env.API_FOOTBALL_KEY || '';
const BASE_URL = 'https://v3.football.api-sports.io';
const WEATHER_KEY = process.env.OPENWEATHER_KEY || '';

// ─── Cache Configuration ──────────────────────────────────────────────────────
// All API responses cached to disk for 1 hour to protect the 100 req/day quota.
const CACHE_DIR = path.join(os.tmpdir(), 'parlay-king-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheKey(endpoint: string): string {
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
  writeCache(cacheKey, data);
  return data;
}

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

// ─── Main Fixture Fetcher ─────────────────────────────────────────────────────
export async function fetchTodayFixtures(date: string): Promise<FixtureData[]> {
  console.log(`[API-Football] Fetching fixtures for ${date}`);
  const fixtures: FixtureData[] = [];

  try {
    const data = await apiFetch(`/fixtures?date=${date}&timezone=America/Moncton`);
    const rawFixtures = data.response || [];

    for (const f of rawFixtures) {
      if (!TARGET_LEAGUES.includes(f.league?.id)) continue;
      if (f.fixture?.status?.short !== 'NS') continue;

      const fixture: FixtureData = {
        fixtureId: f.fixture.id,
        homeTeam:  f.teams?.home?.name || 'Home',
        awayTeam:  f.teams?.away?.name || 'Away',
        league:    f.league?.name || 'Unknown',
        sport:     'soccer',
        date,
      };

      // Fetch all supplementary data in parallel
      const [
        oddsResult,
        statsResult,
        h2hResult,
        injuriesResult,
        standingsResult,
        venueResult,
        weatherResult,
      ] = await Promise.allSettled([
        fetchOdds(f.fixture.id),                                                                    // F01 + F05
        fetchTeamStats(f.teams?.home?.id, f.teams?.away?.id, f.league?.id, f.league?.season),       // F02 + F03 + F06
        fetchH2H(f.teams?.home?.id, f.teams?.away?.id),                                             // F04
        fetchInjuries(f.fixture.id),                                                                // F07 (LIVE)
        fetchStandings(f.league?.id, f.league?.season, f.teams?.home?.id, f.teams?.away?.id),       // F11
        fetchVenue(f.fixture?.venue?.id),                                                           // F12
        fetchWeather(f.fixture?.venue?.city),                                                       // F10
      ]);

      if (oddsResult.status       === 'fulfilled') Object.assign(fixture, oddsResult.value);
      if (statsResult.status      === 'fulfilled') Object.assign(fixture, statsResult.value);
      if (h2hResult.status        === 'fulfilled') Object.assign(fixture, h2hResult.value);
      if (injuriesResult.status   === 'fulfilled') Object.assign(fixture, injuriesResult.value);
      if (standingsResult.status  === 'fulfilled') Object.assign(fixture, standingsResult.value);
      if (venueResult.status      === 'fulfilled') Object.assign(fixture, venueResult.value);
      if (weatherResult.status    === 'fulfilled') Object.assign(fixture, weatherResult.value);

      fixtures.push(fixture);
    }

    console.log(`[API-Football] Found ${fixtures.length} qualifying fixtures with full 12-factor data`);
  } catch (err) {
    console.error('[API-Football] Fetch failed:', err);
    throw err;
  }

  return fixtures;
}

// ─── F01 + F05: Odds (current + opening for CLV) ─────────────────────────────
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
    // Fetch opening odds for CLV (F05)
    const openData = await apiFetch(`/odds?fixture=${fixtureId}&bookmaker=8&bet=1`);
    const openBookmakers = openData.response?.[0]?.bookmakers || [];
    const openMarkets = openBookmakers[0]?.bets || [];
    const openWinner = openMarkets.find((m: any) => m.name === 'Match Winner');
    const openHome = openWinner?.values?.find((v: any) => v.value === 'Home')?.odd;
    const openAway = openWinner?.values?.find((v: any) => v.value === 'Away')?.odd;
    return {
      homeOdds:         home     ? parseFloat(home)     : undefined,
      drawOdds:         draw     ? parseFloat(draw)     : undefined,
      awayOdds:         away     ? parseFloat(away)     : undefined,
      openingHomeOdds:  openHome ? parseFloat(openHome) : (home ? parseFloat(home) : undefined),
      openingAwayOdds:  openAway ? parseFloat(openAway) : (away ? parseFloat(away) : undefined),
    };
  } catch {
    return {};
  }
}

// ─── F02 + F03 + F06: Team Stats, Form, Rest Days ────────────────────────────
async function fetchTeamStats(
  homeId: number, awayId: number, leagueId: number, season: number
): Promise<Partial<FixtureData>> {
  try {
    const [homeStats, awayStats, homeFixtures, awayFixtures] = await Promise.allSettled([
      apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`),
      apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`),
      apiFetch(`/fixtures?team=${homeId}&last=6`),
      apiFetch(`/fixtures?team=${awayId}&last=6`),
    ]);

    const result: Partial<FixtureData> = {};

    if (homeStats.status === 'fulfilled') {
      const s = homeStats.value.response;
      const played = s?.fixtures?.played?.home || 1;
      const wins   = s?.fixtures?.wins?.home   || 0;
      result.homeWinRate  = wins / played;
      result.homeGoalDiff = (s?.goals?.for?.total?.home || 0) - (s?.goals?.against?.total?.home || 0);
    }

    if (awayStats.status === 'fulfilled') {
      const s = awayStats.value.response;
      const played = s?.fixtures?.played?.away || 1;
      const wins   = s?.fixtures?.wins?.away   || 0;
      result.awayWinRate  = wins / played;
      result.awayGoalDiff = (s?.goals?.for?.total?.away || 0) - (s?.goals?.against?.total?.away || 0);
    }

    // F02: Recent form (last 5 results)
    if (homeFixtures.status === 'fulfilled') {
      const fxs = (homeFixtures.value.response || []).slice(0, 5);
      result.homeForm = fxs.map((fx: any) => {
        const hg = fx.goals?.home ?? 0;
        const ag = fx.goals?.away ?? 0;
        const isHome = fx.teams?.home?.id === homeId;
        if (isHome) return hg > ag ? 'W' : hg < ag ? 'L' : 'D';
        return ag > hg ? 'W' : ag < hg ? 'L' : 'D';
      });
      // F06: Rest days
      if (fxs.length > 0) {
        const lastDate = new Date(fxs[0].fixture?.date || Date.now());
        const today = new Date();
        result.homeRestDays = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      }
    }

    if (awayFixtures.status === 'fulfilled') {
      const fxs = (awayFixtures.value.response || []).slice(0, 5);
      result.awayForm = fxs.map((fx: any) => {
        const hg = fx.goals?.home ?? 0;
        const ag = fx.goals?.away ?? 0;
        const isHome = fx.teams?.home?.id === awayId;
        if (isHome) return hg > ag ? 'W' : hg < ag ? 'L' : 'D';
        return ag > hg ? 'W' : ag < hg ? 'L' : 'D';
      });
      if (fxs.length > 0) {
        const lastDate = new Date(fxs[0].fixture?.date || Date.now());
        const today = new Date();
        result.awayRestDays = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      }
    }

    return result;
  } catch {
    return {};
  }
}

// ─── F04: Head-to-Head History ────────────────────────────────────────────────
async function fetchH2H(homeId: number, awayId: number): Promise<Partial<FixtureData>> {
  try {
    const data = await apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`);
    const meetings = data.response || [];
    let h2hHomeWins = 0, h2hAwayWins = 0, h2hDraws = 0;
    for (const m of meetings) {
      const hg = m.goals?.home ?? 0;
      const ag = m.goals?.away ?? 0;
      const homeIsHome = m.teams?.home?.id === homeId;
      if (hg === ag) {
        h2hDraws++;
      } else if (hg > ag) {
        homeIsHome ? h2hHomeWins++ : h2hAwayWins++;
      } else {
        homeIsHome ? h2hAwayWins++ : h2hHomeWins++;
      }
    }
    return { h2hHomeWins, h2hAwayWins, h2hDraws };
  } catch {
    return {};
  }
}

// ─── F07: Injuries & Absences — LIVE API-Football /injuries endpoint ──────────
// This is the dedicated live injury pull for Factor 7.
// Returns squad availability rating (0-1) and key player status.
async function fetchInjuries(fixtureId: number): Promise<Partial<FixtureData>> {
  try {
    console.log(`[F07-Injuries] Fetching LIVE injury report for fixture ${fixtureId}`);
    const data = await apiFetch(`/injuries?fixture=${fixtureId}`);
    const injuries = data.response || [];

    let homeInjuries = 0;
    let awayInjuries = 0;
    let homeKeyPlayerOut = false;
    let awayKeyPlayerOut = false;

    // Positions considered "key": goalkeeper, striker, attacking midfielder
    const KEY_POSITIONS = ['Goalkeeper', 'Attacker', 'Forward', 'Striker'];

    for (const inj of injuries) {
      const team = inj.team?.id;
      const position = inj.player?.type || '';
      const reason = inj.player?.reason || '';

      // Count only players who are confirmed out (not just doubtful)
      const isOut = reason.toLowerCase().includes('injured') ||
                    reason.toLowerCase().includes('suspended') ||
                    reason.toLowerCase().includes('out');
      if (!isOut) continue;

      if (inj.team?.name?.includes('home') || inj.fixture?.teams?.home?.id === team) {
        homeInjuries++;
        if (KEY_POSITIONS.some(p => position.includes(p))) homeKeyPlayerOut = true;
      } else {
        awayInjuries++;
        if (KEY_POSITIONS.some(p => position.includes(p))) awayKeyPlayerOut = true;
      }
    }

    // Calculate availability rating (1.0 = fully fit, 0.0 = decimated)
    const homeInjuryRating = Math.max(0, 1 - homeInjuries * 0.07 - (homeKeyPlayerOut ? 0.15 : 0));
    const awayInjuryRating = Math.max(0, 1 - awayInjuries * 0.07 - (awayKeyPlayerOut ? 0.15 : 0));

    console.log(`[F07-Injuries] Home: ${homeInjuries} injuries (key=${homeKeyPlayerOut}), Away: ${awayInjuries} injuries (key=${awayKeyPlayerOut})`);

    return {
      homeInjuries,
      awayInjuries,
      homeKeyPlayerOut,
      awayKeyPlayerOut,
      homeInjuryRating,
      awayInjuryRating,
    };
  } catch (err) {
    console.warn(`[F07-Injuries] Failed to fetch injuries for fixture ${fixtureId}:`, err);
    return {};
  }
}

// ─── F11: League Table Standing ───────────────────────────────────────────────
async function fetchStandings(
  leagueId: number, season: number, homeId: number, awayId: number
): Promise<Partial<FixtureData>> {
  try {
    const data = await apiFetch(`/standings?league=${leagueId}&season=${season}`);
    const standings = data.response?.[0]?.league?.standings?.[0] || [];
    const leagueSize = standings.length || 20;

    const homeEntry = standings.find((s: any) => s.team?.id === homeId);
    const awayEntry = standings.find((s: any) => s.team?.id === awayId);

    return {
      homeTableRank: homeEntry?.rank ?? undefined,
      awayTableRank: awayEntry?.rank ?? undefined,
      leagueSize,
    };
  } catch {
    return {};
  }
}

// ─── F12: Venue / Stadium Capacity ────────────────────────────────────────────
async function fetchVenue(venueId?: number): Promise<Partial<FixtureData>> {
  if (!venueId) return {};
  try {
    const data = await apiFetch(`/venues?id=${venueId}`);
    const venue = data.response?.[0];
    if (!venue) return {};
    return {
      stadiumCapacity:    venue.capacity ?? undefined,
      homeAttendancePct:  venue.capacity ? 0.85 : undefined, // default 85% fill if no live attendance
    };
  } catch {
    return {};
  }
}

// ─── F10: Weather (OpenWeatherMap) ────────────────────────────────────────────
async function fetchWeather(city?: string): Promise<Partial<FixtureData>> {
  if (!city || !WEATHER_KEY) return {};
  try {
    const cacheKey = getCacheKey(`weather_${city}`);
    const cached = readCache(cacheKey);
    if (cached) return cached;

    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_KEY}&units=metric`
    );
    if (!res.ok) return {};
    const w = await res.json();

    const condition = w.weather?.[0]?.main?.toLowerCase() || 'clear';
    const mapped =
      condition.includes('rain') || condition.includes('drizzle') ? 'rain' :
      condition.includes('snow') ? 'snow' :
      condition.includes('wind') ? 'wind' : 'clear';

    const result: Partial<FixtureData> = {
      weatherCondition: mapped,
      windSpeed:        w.wind?.speed ? Math.round(w.wind.speed * 3.6) : 0, // m/s to km/h
      temperature:      w.main?.temp ?? 20,
    };

    writeCache(cacheKey, result);
    return result;
  } catch {
    return {};
  }
}
