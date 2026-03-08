/**
 * Results Settler — Gold Standard V3 Titan XII
 * Automatically fetches final scores from API-Football / API-Basketball
 * and settles all pending picks with accurate win/loss/push status.
 *
 * Called every 2 hours by the scheduler.
 * Only settled picks appear on the Results page.
 * Main page tabs only show picks with status = 'pending'.
 */

import * as storage from './storage.js';
import { pingGoogleAfterUpdate } from './seo.js';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || process.env.RAPIDAPI_KEY || '';
const API_BASKETBALL_KEY = process.env.API_BASKETBALL_KEY || API_FOOTBALL_KEY;

// ─── Fetch final score from API-Football ─────────────────────────────────────
async function fetchSoccerFinalScore(fixtureId: string): Promise<{
  homeScore: number;
  awayScore: number;
  status: string;
  elapsed: number;
} | null> {
  try {
    const url = `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`;
    const res = await fetch(url, {
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY,
        'x-rapidapi-key': API_FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io',
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const fixture = data?.response?.[0];
    if (!fixture) return null;

    const statusCode = fixture.fixture?.status?.short;
    const elapsed = fixture.fixture?.status?.elapsed || 0;
    const homeScore = fixture.goals?.home ?? -1;
    const awayScore = fixture.goals?.away ?? -1;

    return { homeScore, awayScore, status: statusCode, elapsed };
  } catch (err) {
    console.error(`[Settler] Soccer score fetch error for fixture ${fixtureId}:`, err);
    return null;
  }
}

// ─── Fetch final score from API-Basketball (NBA) ─────────────────────────────
async function fetchNBAFinalScore(fixtureId: string): Promise<{
  homeScore: number;
  awayScore: number;
  status: string;
  totalPoints: number;
} | null> {
  try {
    const url = `https://v1.basketball.api-sports.io/games?id=${fixtureId}`;
    const res = await fetch(url, {
      headers: {
        'x-apisports-key': API_BASKETBALL_KEY,
        'x-rapidapi-key': API_BASKETBALL_KEY,
        'x-rapidapi-host': 'v1.basketball.api-sports.io',
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const game = data?.response?.[0];
    if (!game) return null;

    const statusCode = game.status?.short;
    const homeScore = game.scores?.home?.total ?? -1;
    const awayScore = game.scores?.away?.total ?? -1;
    const totalPoints = homeScore + awayScore;

    return { homeScore, awayScore, status: statusCode, totalPoints };
  } catch (err) {
    console.error(`[Settler] NBA score fetch error for game ${fixtureId}:`, err);
    return null;
  }
}

// ─── Determine if a soccer fixture is finished ────────────────────────────────
function isSoccerFinished(status: string): boolean {
  // FT = Full Time, AET = After Extra Time, PEN = Penalties
  return ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(status);
}

// ─── Determine if an NBA game is finished ─────────────────────────────────────
function isNBAFinished(status: string): boolean {
  return ['FT', 'AOT'].includes(status); // FT = Final, AOT = After Overtime
}

// ─── Evaluate pick result based on prediction and final score ─────────────────
function evaluatePick(
  prediction: string,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number,
  sport: string,
  totalPoints?: number
): 'won' | 'lost' | 'void' {
  const pred = prediction.toLowerCase().trim();

  // ── Over/Under (NBA & Soccer) ──
  const overMatch = pred.match(/over\s+([\d.]+)/);
  const underMatch = pred.match(/under\s+([\d.]+)/);

  if (overMatch) {
    const line = parseFloat(overMatch[1]);
    const total = sport === 'nba' ? (totalPoints ?? homeScore + awayScore) : homeScore + awayScore;
    if (total === line) return 'void'; // push
    return total > line ? 'won' : 'lost';
  }

  if (underMatch) {
    const line = parseFloat(underMatch[1]);
    const total = sport === 'nba' ? (totalPoints ?? homeScore + awayScore) : homeScore + awayScore;
    if (total === line) return 'void'; // push
    return total < line ? 'won' : 'lost';
  }

  // ── Home Win / ML ──
  if (pred.includes('home win') || pred.includes(homeTeam.toLowerCase() + ' win') ||
      pred.includes(homeTeam.toLowerCase() + ' ml') || pred.includes(homeTeam.toLowerCase() + ' moneyline')) {
    return homeScore > awayScore ? 'won' : 'lost';
  }

  // ── Away Win / ML ──
  if (pred.includes('away win') || pred.includes(awayTeam.toLowerCase() + ' win') ||
      pred.includes(awayTeam.toLowerCase() + ' ml') || pred.includes(awayTeam.toLowerCase() + ' moneyline')) {
    return awayScore > homeScore ? 'won' : 'lost';
  }

  // ── Draw ──
  if (pred.includes('draw') && !pred.includes('or draw')) {
    return homeScore === awayScore ? 'won' : 'lost';
  }

  // ── Double Chance: Home or Draw (1X) ──
  if ((pred.includes('home or draw') || pred.includes('win or draw') || pred.includes('1x')) &&
      !pred.includes(awayTeam.toLowerCase())) {
    return homeScore >= awayScore ? 'won' : 'lost';
  }

  // ── Double Chance: Away or Draw (X2) ──
  if (pred.includes('away or draw') || pred.includes('x2') ||
      (pred.includes('win or draw') && pred.includes(awayTeam.toLowerCase()))) {
    return awayScore >= homeScore ? 'won' : 'lost';
  }

  // ── Double Chance: Home or Away (12) ──
  if (pred.includes('home or away') || pred.includes('12')) {
    return homeScore !== awayScore ? 'won' : 'lost';
  }

  // ── BTTS (Both Teams to Score) ──
  if (pred.includes('btts') || pred.includes('both teams to score')) {
    return homeScore > 0 && awayScore > 0 ? 'won' : 'lost';
  }

  // ── Over 1.5 / 2.5 / 3.5 Goals ──
  const goalsMatch = pred.match(/over\s+([\d.]+)\s*goals?/);
  if (goalsMatch) {
    const line = parseFloat(goalsMatch[1]);
    const total = homeScore + awayScore;
    return total > line ? 'won' : 'lost';
  }

  // ── Spread (NBA: -2.5, +5.5 etc) ──
  const spreadMatch = pred.match(/([\w\s]+)\s+([+-][\d.]+)/);
  if (spreadMatch) {
    const teamName = spreadMatch[1].trim().toLowerCase();
    const spread = parseFloat(spreadMatch[2]);
    const isHome = homeTeam.toLowerCase().includes(teamName) || teamName.includes(homeTeam.toLowerCase().split(' ').pop() || '');
    const margin = isHome ? homeScore - awayScore : awayScore - homeScore;
    const adjustedMargin = margin + spread;
    if (adjustedMargin === 0) return 'void';
    return adjustedMargin > 0 ? 'won' : 'lost';
  }

  // ── Fallback: generic team win ──
  const homeWords = homeTeam.toLowerCase().split(' ');
  const awayWords = awayTeam.toLowerCase().split(' ');
  for (const word of homeWords) {
    if (word.length > 3 && pred.includes(word)) {
      return homeScore > awayScore ? 'won' : 'lost';
    }
  }
  for (const word of awayWords) {
    if (word.length > 3 && pred.includes(word)) {
      return awayScore > homeScore ? 'won' : 'lost';
    }
  }

  console.warn(`[Settler] Could not evaluate prediction: "${prediction}" — marking void`);
  return 'void';
}

// ─── Main Settler Function ────────────────────────────────────────────────────
export async function autoSettleResults(): Promise<{
  checked: number;
  settled: number;
  wins: number;
  losses: number;
  voids: number;
  errors: number;
}> {
  const stats = { checked: 0, settled: 0, wins: 0, losses: 0, voids: 0, errors: 0 };

  try {
    // Get all picks that are still pending
    const allPicks = await storage.getAllPicks(500);
    const pendingPicks = allPicks.filter(p => p.status === 'pending');

    if (pendingPicks.length === 0) {
      console.log('[Settler] No pending picks to settle');
      return stats;
    }

    console.log(`[Settler] Checking ${pendingPicks.length} pending picks...`);
    stats.checked = pendingPicks.length;

    // Only try to settle picks from past dates (not today)
    const today = new Date().toISOString().split('T')[0];

    for (const pick of pendingPicks) {
      // Skip today's picks — games may not have finished yet
      if (pick.date >= today) continue;

      // Skip picks without a fixtureId
      if (!pick.fixtureId) {
        // For picks without fixtureId, check if the date is old enough (2+ days) and mark void
        const pickDate = new Date(pick.date);
        const daysDiff = (Date.now() - pickDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff >= 2) {
          await storage.updatePick(pick.id, { status: 'void' });
          await storage.createResult({
            pickId: pick.id,
            date: pick.date,
            sport: pick.sport,
            homeTeam: pick.homeTeam,
            awayTeam: pick.awayTeam,
            prediction: pick.prediction,
            confidence: pick.confidence,
            result: 'void',
            tier: pick.tier || 'free',
            actualScore: 'N/A',
            notes: 'No fixture ID — auto-voided after 48h',
          });
          stats.settled++;
          stats.voids++;
        }
        continue;
      }

      try {
        let outcome: 'won' | 'lost' | 'void' | null = null;
        let actualScore = '';

        if (pick.sport === 'nba') {
          // ── NBA Settlement ──
          const score = await fetchNBAFinalScore(pick.fixtureId);
          if (!score) { stats.errors++; continue; }
          if (!isNBAFinished(score.status)) continue; // Game not finished yet

          actualScore = `${score.homeScore}-${score.awayScore} (Total: ${score.totalPoints})`;
          outcome = evaluatePick(
            pick.prediction,
            pick.homeTeam,
            pick.awayTeam,
            score.homeScore,
            score.awayScore,
            'nba',
            score.totalPoints
          );

        } else {
          // ── Soccer / MLS Settlement ──
          const score = await fetchSoccerFinalScore(pick.fixtureId);
          if (!score) { stats.errors++; continue; }
          if (!isSoccerFinished(score.status)) continue; // Game not finished yet

          actualScore = `${score.homeScore}-${score.awayScore}`;
          outcome = evaluatePick(
            pick.prediction,
            pick.homeTeam,
            pick.awayTeam,
            score.homeScore,
            score.awayScore,
            pick.sport
          );
        }

        if (!outcome) continue;

        // ── Update pick status in DB ──
        await storage.updatePick(pick.id, { status: outcome });

        // ── Create result record ──
        await storage.createResult({
          pickId: pick.id,
          date: pick.date,
          sport: pick.sport,
          homeTeam: pick.homeTeam,
          awayTeam: pick.awayTeam,
          prediction: pick.prediction,
          confidence: pick.confidence,
          result: outcome,
          tier: pick.tier || 'free',
          actualScore,
          notes: `Auto-settled by Titan XII Settler v3 | Fixture: ${pick.fixtureId}`,
        });

        stats.settled++;
        if (outcome === 'won') stats.wins++;
        else if (outcome === 'lost') stats.losses++;
        else stats.voids++;

        console.log(`[Settler] ✅ Settled: ${pick.homeTeam} vs ${pick.awayTeam} | ${pick.prediction} | ${actualScore} → ${outcome.toUpperCase()}`);

        // Small delay to avoid API rate limits
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        console.error(`[Settler] Error settling pick ${pick.id}:`, err);
        stats.errors++;
      }
    }

    if (stats.settled > 0) {
      console.log(`[Settler] Settlement complete: ${stats.settled} settled (${stats.wins}W / ${stats.losses}L / ${stats.voids}V)`);
      // Ping Google so results page gets re-indexed
      pingGoogleAfterUpdate('results-settled').catch(() => {});
    } else {
      console.log('[Settler] No picks ready to settle yet (games may still be in progress)');
    }

  } catch (err) {
    console.error('[Settler] Fatal error in autoSettleResults:', err);
    stats.errors++;
  }

  return stats;
}

// ─── Public API: Get results for the Results page ────────────────────────────
// Returns only settled picks (won/lost/void) — never pending
export async function getSettledResults(limit = 200) {
  const results = await storage.getResults(limit);
  return results.filter(r => ['won', 'lost', 'void'].includes(r.result));
}

// ─── Public API: Get win/loss summary ────────────────────────────────────────
export async function getResultsSummary() {
  return storage.getWinLossSummary();
}
