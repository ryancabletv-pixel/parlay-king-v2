// Restore all 92 historical results from cPanel pick_results.json
// Run: node scripts/restore_92_results.js

const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// All 92 entries from cPanel pick_results.json
const cpanelHistory = JSON.parse(fs.readFileSync('/tmp/cpanel_results.json', 'utf-8')).history;

function mapResult(r) {
  const lower = (r || '').toLowerCase();
  if (lower === 'won' || lower === 'win' || lower === 'w') return 'won';
  if (lower === 'lost' || lower === 'loss' || lower === 'l') return 'lost';
  return 'pending';
}

function parseConf(entry) {
  // Try confidence field first, then probability
  if (entry.confidence && entry.confidence !== '' && entry.confidence !== 'Medium' && entry.confidence !== 'High') {
    const num = parseFloat(entry.confidence.replace('%', ''));
    if (!isNaN(num)) return Math.round(num);
  }
  if (entry.probability) {
    const p = parseFloat(entry.probability);
    if (!isNaN(p)) return p > 1 ? Math.round(p) : Math.round(p * 100);
  }
  return null;
}

function parseSport(entry) {
  const league = (entry.league || '').toLowerCase();
  const game = (entry.game || '').toLowerCase();
  if (league === 'nba' || game.includes('warriors') || game.includes('celtics') || game.includes('lakers') || game.includes('thunder') || game.includes('mavericks') || game.includes('rockets') || game.includes('nets') || game.includes('cavaliers') || game.includes('bucks') || game.includes('heat') || game.includes('knicks') || game.includes('suns') || game.includes('nuggets') || game.includes('clippers') || game.includes('pistons') || game.includes('bulls') || game.includes('spurs') || game.includes('grizzlies') || game.includes('pelicans') || game.includes('jazz') || game.includes('kings') || game.includes('hawks') || game.includes('hornets') || game.includes('magic') || game.includes('pacers') || game.includes('raptors') || game.includes('76ers') || game.includes('wizards') || game.includes('trail blazers')) return 'nba';
  if (league === 'mls' || game.includes('fc dallas') || game.includes('inter miami') || game.includes('lafc') || game.includes('seattle sounders') || game.includes('portland timbers')) return 'mls';
  return 'soccer';
}

function parseTeams(game) {
  // Handle "Team A @ Team B" or "Team A vs Team B"
  let home, away;
  if (game.includes(' @ ')) {
    const parts = game.split(' @ ');
    away = parts[0].trim();
    home = parts[1].trim();
  } else if (game.includes(' vs ')) {
    const parts = game.split(' vs ');
    home = parts[0].trim();
    away = parts[1].trim();
  } else {
    home = game;
    away = '';
  }
  return { home, away };
}

async function restore() {
  const client = await pool.connect();
  try {
    // Clear existing results
    await client.query('DELETE FROM results');
    console.log('Cleared existing results');

    let inserted = 0;
    for (const entry of cpanelHistory) {
      const { home, away } = parseTeams(entry.game || '');
      const result = mapResult(entry.result);
      const conf = parseConf(entry);
      const sport = parseSport(entry);

      const matchStr = home && away ? home + ' vs ' + away : (entry.game || '');
      await client.query(
        `INSERT INTO results (date, sport, home_team, away_team, match, pick, prediction, confidence, result, tier, actual_score, league, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
        [
          entry.date,
          sport,
          home,
          away,
          matchStr,
          entry.pick || '',
          entry.pick || '',
          conf,
          result,
          'free',
          entry.score || null,
          entry.league || null,
          entry.notes || null
        ]
      );
      inserted++;
    }

    console.log(`Inserted ${inserted} results`);

    // Verify
    const { rows } = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result = 'lost' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) as pending
      FROM results
    `);
    console.log('Verification:', rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}

restore().catch(console.error);
