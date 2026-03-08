/**
 * restore_results.js
 * Restores all historical win/loss results from pick_results.json (cPanel) into the Railway DB.
 * Run: node scripts/restore_results.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Historical data from cPanel pick_results.json (as of March 7, 2026) ──────
const HISTORY = [
  // March 7, 2026
  { date: '2026-03-07', game: 'Golden State Warriors @ Oklahoma City Thunder', league: 'NBA', pick: 'Over 219.5', probability: '0.69', score: '', result: 'Pending', sport: 'nba' },
  { date: '2026-03-07', game: 'FSV Mainz 05 vs VfB Stuttgart', league: 'Bundesliga', pick: 'VfB Stuttgart Win or Draw', probability: '0.682', score: '2-2', result: 'Won', sport: 'soccer' },
  { date: '2026-03-07', game: 'PSV Eindhoven vs AZ Alkmaar', league: 'Eredivisie', pick: 'PSV Eindhoven ML', probability: '0.75', score: '2-1', result: 'Won', sport: 'soccer' },
  { date: '2026-03-07', game: '1. FC Heidenheim vs 1899 Hoffenheim', league: 'Bundesliga', pick: '1899 Hoffenheim ML', probability: '0.68', score: '', result: 'Pending', sport: 'soccer' },
  { date: '2026-03-07', game: 'Cagliari vs Como', league: 'Serie A', pick: 'Como ML', probability: '0.70', score: '1-2', result: 'Won', sport: 'soccer' },
  // March 6, 2026
  { date: '2026-03-06', game: 'Dallas Mavericks @ Boston Celtics', league: 'NBA', pick: 'Boston Celtics', probability: '0.675', score: 'Mavericks 100 – Celtics 120', result: 'Won', sport: 'nba' },
  { date: '2026-03-06', game: 'New Orleans Pelicans @ Phoenix Suns', league: 'NBA', pick: 'Phoenix Suns ML', probability: '0.78', score: 'Pelicans 116 – Suns 118', result: 'Won', sport: 'nba' },
  { date: '2026-03-06', game: 'Indiana Pacers @ Los Angeles Lakers', league: 'NBA', pick: 'Los Angeles Lakers ML', probability: '0.76', score: 'Pacers 117 – Lakers 128', result: 'Won', sport: 'nba' },
  { date: '2026-03-06', game: 'Bayern Munich vs Bor. Mönchengladbach', league: 'Bundesliga', pick: 'Bayern Munich ML', probability: '0.92', score: 'Bayern Munich 4 – Gladbach 1', result: 'Won', sport: 'soccer' },
  { date: '2026-03-06', game: 'Heracles vs Utrecht', league: 'Eredivisie', pick: 'Utrecht Win or Draw', probability: '0.677', score: 'Heracles 0 – Utrecht 0', result: 'Won', sport: 'soccer' },
  { date: '2026-03-06', game: 'Stade Rennais vs Stade Brestois', league: 'Ligue 1', pick: 'Stade Brestois Win or Draw', probability: '0.68', score: 'Rennais 1 – Brestois 2', result: 'Won', sport: 'soccer' },
  { date: '2026-03-06', game: 'Getafe vs Celta Vigo', league: 'La Liga', pick: 'Celta Vigo Win or Draw', probability: '0.68', score: 'Getafe 0 – Celta Vigo 1', result: 'Won', sport: 'soccer' },
  { date: '2026-03-06', game: 'Lecce vs Empoli', league: 'Serie A', pick: 'Empoli Win or Draw', probability: '0.69', score: 'Lecce 1 – Empoli 1', result: 'Won', sport: 'soccer' },
  // March 5, 2026
  { date: '2026-03-05', game: 'Houston Rockets @ Washington Wizards', league: 'NBA', pick: 'Houston Rockets', probability: '0.82', score: 'Rockets 123 – 118 Wizards', result: 'Won', sport: 'nba' },
  { date: '2026-03-05', game: 'Denver Nuggets @ Utah Jazz', league: 'NBA', pick: 'Denver Nuggets', probability: '0.79', score: 'Nuggets 128 – 125 Jazz', result: 'Won', sport: 'nba' },
  // March 4, 2026
  { date: '2026-03-04', game: 'Houston Rockets @ Washington Wizards', league: 'NBA', pick: 'Houston Rockets', probability: '0.82', score: 'Rockets 123 – 118 Wizards', result: 'Won', sport: 'nba' },
  { date: '2026-03-04', game: 'Denver Nuggets @ Utah Jazz', league: 'NBA', pick: 'Denver Nuggets', probability: '0.79', score: 'Nuggets 128 – 125 Jazz', result: 'Won', sport: 'nba' },
  // March 3, 2026
  { date: '2026-03-03', game: 'Houston Rockets @ Washington Wizards', league: 'NBA', pick: 'Houston Rockets', probability: '0.82', score: 'Rockets 123 – 118 Wizards', result: 'Won', sport: 'nba' },
  { date: '2026-03-03', game: 'Denver Nuggets @ Utah Jazz', league: 'NBA', pick: 'Denver Nuggets', probability: '0.79', score: 'Nuggets 128 – 125 Jazz', result: 'Won', sport: 'nba' },
  // March 2, 2026
  { date: '2026-03-02', game: 'Houston Rockets @ Washington Wizards', league: 'NBA', pick: 'Houston Rockets', probability: '0.82', score: 'Rockets 123 – 118 Wizards', result: 'Won', sport: 'nba' },
  { date: '2026-03-02', game: 'Denver Nuggets @ Utah Jazz', league: 'NBA', pick: 'Denver Nuggets', probability: '0.79', score: 'Nuggets 128 – 125 Jazz', result: 'Won', sport: 'nba' },
  // March 1, 2026
  { date: '2026-03-01', game: 'Arsenal vs Brentford', league: 'Premier League', pick: 'Arsenal Win', probability: '0.82', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Espanyol vs Barcelona', league: 'La Liga', pick: 'Barcelona Win', probability: '0.85', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Genoa vs Udinese', league: 'Serie A', pick: 'Under 2.5 Goals', probability: '0.71', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Freiburg vs Union Berlin', league: 'Bundesliga', pick: 'Freiburg Win or Draw', probability: '0.68', score: 'Lost', result: 'Lost', sport: 'soccer' },
  { date: '2026-03-01', game: 'Strasbourg vs Montpellier', league: 'Ligue 1', pick: 'Strasbourg Win', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Man Utd vs Crystal Palace', league: 'Premier League', pick: 'Man Utd Win', probability: '0.74', score: '2-1', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Real Betis vs Osasuna', league: 'La Liga', pick: 'Real Betis Win', probability: '0.73', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Phoenix Suns vs Golden State Warriors', league: 'NBA', pick: 'Over 225.5', probability: '0.71', score: 'Won', result: 'Won', sport: 'nba' },
  { date: '2026-03-01', game: 'Milwaukee Bucks vs Indiana Pacers', league: 'NBA', pick: 'Bucks Win', probability: '0.69', score: 'Lost', result: 'Lost', sport: 'nba' },
  { date: '2026-03-01', game: 'Parlay: Arsenal, Man Utd, Real Betis', league: 'Multi', pick: '3-Leg Parlay', probability: '0.44', score: '3/3 Won', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Real Betis vs Sevilla', league: 'La Liga', pick: 'Real Betis Win', probability: '0.72', score: '2-2 (Early Payout)', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Arsenal vs Chelsea', league: 'Premier League', pick: 'Arsenal Win', probability: '0.79', score: '2-1', result: 'Won', sport: 'soccer' },
  { date: '2026-03-01', game: 'Inter Miami vs Orlando City', league: 'MLS', pick: 'Inter Miami Win', probability: '0.76', score: '4-2', result: 'Won', sport: 'mls' },
  { date: '2026-03-01', game: 'San Diego FC vs St. Louis City SC', league: 'MLS', pick: 'San Diego FC Win', probability: '0.71', score: '2-0', result: 'Won', sport: 'mls' },
  { date: '2026-03-01', game: 'OKC Thunder vs Dallas Mavericks', league: 'NBA', pick: 'OKC Thunder Win', probability: '0.78', score: '100-87', result: 'Won', sport: 'nba' },
  { date: '2026-03-01', game: 'Cleveland Cavaliers vs Brooklyn Nets', league: 'NBA', pick: 'Cleveland Win', probability: '0.66', score: 'Lost', result: 'Lost', sport: 'nba' },
  // February 28, 2026
  { date: '2026-02-28', game: 'Leicester vs Bournemouth', league: 'Premier League', pick: 'Bournemouth Win or Draw', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-28', game: 'Athletic Bilbao vs Mallorca', league: 'La Liga', pick: 'Athletic Bilbao Win', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-28', game: 'Torino vs Empoli', league: 'Serie A', pick: 'Torino Win or Draw', probability: '0.71', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-28', game: 'Nice vs Rennes', league: 'Ligue 1', pick: 'Nice Win', probability: '0.73', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-28', game: 'LA Lakers vs Denver Nuggets', league: 'NBA', pick: 'Under 228.5', probability: '0.70', score: 'Lost', result: 'Lost', sport: 'nba' },
  { date: '2026-02-28', game: 'Boston Celtics vs Cleveland Cavaliers', league: 'NBA', pick: 'Over 220.5', probability: '0.72', score: 'Won', result: 'Won', sport: 'nba' },
  // February 27, 2026
  { date: '2026-02-27', game: 'Man United vs Everton', league: 'Premier League', pick: 'Man United Win or Draw', probability: '0.76', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-27', game: 'Aston Villa vs West Ham', league: 'Premier League', pick: 'Aston Villa Win', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-27', game: 'Real Betis vs Celta Vigo', league: 'La Liga', pick: 'Real Betis Win or Draw', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-27', game: 'Lazio vs Cagliari', league: 'Serie A', pick: 'Lazio Win', probability: '0.76', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-27', game: 'Mainz vs Hoffenheim', league: 'Bundesliga', pick: 'Over 2.5 Goals', probability: '0.68', score: 'Lost', result: 'Lost', sport: 'soccer' },
  // February 26, 2026
  { date: '2026-02-26', game: 'Bologna vs SK Brann', league: 'Europa League', pick: 'Bologna Win', probability: '0.82', score: 'Bologna 1-0 Brann', result: 'Won', sport: 'soccer' },
  { date: '2026-02-26', game: 'Crystal Palace vs Zrinjski Mostar', league: 'Europa Conference', pick: 'Crystal Palace Win', probability: '0.88', score: 'Crystal Palace 2-0 Zrinjski', result: 'Won', sport: 'soccer' },
  { date: '2026-02-26', game: 'Nottingham Forest vs Fenerbahce', league: 'Europa League', pick: 'Forest to Qualify', probability: '0.75', score: 'Forest 1-2 Fenerbahce (4-2 agg)', result: 'Won', sport: 'soccer' },
  { date: '2026-02-26', game: 'Miami Heat vs Philadelphia 76ers', league: 'NBA', pick: 'Under 240.5', probability: '0.70', score: 'Miami 117 - Philly 124 (Total: 241)', result: 'Lost', sport: 'nba' },
  { date: '2026-02-26', game: 'Houston Rockets vs Orlando Magic', league: 'NBA', pick: 'Over 215.5', probability: '0.72', score: 'Houston 113 - Orlando 108 (Total: 221)', result: 'Won', sport: 'nba' },
  { date: '2026-02-26', game: 'Sacramento Kings vs Dallas Mavericks', league: 'NBA', pick: 'Under 236.5', probability: '0.70', score: 'Sacramento 130 - Dallas 121 (Total: 251)', result: 'Lost', sport: 'nba' },
  // February 25, 2026
  { date: '2026-02-25', game: 'Chelsea vs Brighton', league: 'Premier League', pick: 'Chelsea Win', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-25', game: 'Real Sociedad vs Villarreal', league: 'La Liga', pick: 'Under 2.5 Goals', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-25', game: 'Atalanta vs Fiorentina', league: 'Serie A', pick: 'Over 2.5 Goals', probability: '0.73', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-25', game: 'Wolfsburg vs Leipzig', league: 'Bundesliga', pick: 'Leipzig Win', probability: '0.75', score: 'Lost', result: 'Lost', sport: 'soccer' },
  { date: '2026-02-25', game: 'Lille vs Monaco', league: 'Ligue 1', pick: 'Under 3.5 Goals', probability: '0.71', score: 'Won', result: 'Won', sport: 'soccer' },
  // February 24, 2026
  { date: '2026-02-24', game: 'Arsenal vs Newcastle', league: 'Premier League', pick: 'Arsenal Win or Draw', probability: '0.78', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-24', game: 'Real Madrid vs Girona', league: 'La Liga', pick: 'Real Madrid Win', probability: '0.82', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-24', game: 'AC Milan vs Roma', league: 'Serie A', pick: 'AC Milan Win or Draw', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-24', game: 'Leverkusen vs Stuttgart', league: 'Bundesliga', pick: 'Leverkusen Win', probability: '0.79', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-24', game: 'Marseille vs Lyon', league: 'Ligue 1', pick: 'Over 2.5 Goals', probability: '0.70', score: 'Lost', result: 'Lost', sport: 'soccer' },
  // February 23, 2026
  { date: '2026-02-23', game: 'Tottenham vs Wolves', league: 'Premier League', pick: 'Tottenham Win', probability: '0.76', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-23', game: 'Atletico Madrid vs Sevilla', league: 'La Liga', pick: 'Atletico Win', probability: '0.78', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-23', game: 'Dortmund vs Frankfurt', league: 'Bundesliga', pick: 'Over 2.5 Goals', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-23', game: 'Celtic vs Rangers', league: 'Scottish Premiership', pick: 'Celtic Win', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-23', game: 'Porto vs Braga', league: 'Primeira Liga', pick: 'Porto Win', probability: '0.73', score: 'Lost', result: 'Lost', sport: 'soccer' },
  { date: '2026-02-23', game: 'Napoli vs Juventus', league: 'Serie A', pick: 'Under 2.5 Goals', probability: '0.71', score: 'Won', result: 'Won', sport: 'soccer' },
  // February 22, 2026
  { date: '2026-02-22', game: 'Barcelona vs Real Valladolid', league: 'La Liga', pick: 'Barcelona Win', probability: '0.88', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'Liverpool vs Man City', league: 'Premier League', pick: 'Liverpool Win or Draw', probability: '0.74', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'Bayern Munich vs Augsburg', league: 'Bundesliga', pick: 'Bayern Win', probability: '0.87', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'PSG vs Nantes', league: 'Ligue 1', pick: 'PSG Win', probability: '0.86', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'Inter Milan vs Lecce', league: 'Serie A', pick: 'Inter Win', probability: '0.83', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'Benfica vs Sporting', league: 'Primeira Liga', pick: 'Over 2.5 Goals', probability: '0.72', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-22', game: 'Ajax vs Feyenoord', league: 'Eredivisie', pick: 'Over 2.5 Goals', probability: '0.71', score: 'Lost', result: 'Lost', sport: 'soccer' },
  // February 21, 2026
  { date: '2026-02-21', game: 'PSV vs Go Ahead Eagles', league: 'Eredivisie', pick: 'PSV Win', probability: '0.86', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-21', game: 'Real Madrid vs Las Palmas', league: 'La Liga', pick: 'Real Madrid Win', probability: '0.88', score: 'Won', result: 'Won', sport: 'soccer' },
  { date: '2026-02-21', game: 'Aston Villa vs Ipswich', league: 'Premier League', pick: 'Aston Villa Win', probability: '0.76', score: 'Won', result: 'Won', sport: 'soccer' },
];

async function restoreResults() {
  const client = await pool.connect();
  try {
    // Check current count
    const existing = await client.query('SELECT COUNT(*) FROM results');
    console.log(`Current results in DB: ${existing.rows[0].count}`);

    // Clear existing results to avoid duplicates
    if (parseInt(existing.rows[0].count) > 0) {
      await client.query('DELETE FROM results');
      console.log('Cleared existing results');
    }

    let inserted = 0;
    for (const r of HISTORY) {
      const resultVal = r.result === 'Won' ? 'won' : r.result === 'Lost' ? 'lost' : 'void';
      const conf = parseFloat(r.probability) * 100;
      const [homeTeam, awayTeam] = r.game.includes(' vs ') 
        ? r.game.split(' vs ').map(s => s.trim())
        : r.game.includes(' @ ')
          ? [r.game.split(' @ ')[1].trim(), r.game.split(' @ ')[0].trim()]
          : [r.game, ''];

      await client.query(
        `INSERT INTO results (date, match, pick, sport, home_team, away_team, prediction, confidence, result, tier, actual_score, notes, league)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          r.date,
          r.game,
          r.pick,
          r.sport || 'soccer',
          homeTeam,
          awayTeam,
          r.pick,
          isNaN(conf) ? null : conf,
          resultVal,
          'free',
          r.score || null,
          null,
          r.league || null
        ]
      );
      inserted++;
      console.log(`  ✅ ${r.date}: ${r.game} → ${r.result}`);
    }

    console.log(`\n✅ Restored ${inserted} results to Railway DB`);

    // Verify
    const final = await client.query('SELECT COUNT(*), result FROM results GROUP BY result');
    console.log('\nFinal DB state:');
    for (const row of final.rows) {
      console.log(`  ${row.result}: ${row.count}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

restoreResults().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
