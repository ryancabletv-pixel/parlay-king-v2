// Direct DB insert for the 3 specified soccer picks
import pg from 'pg';
const { Client } = pg;

const DB_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_WPim3gY4lKTj@ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require';

const client = new Client({ connectionString: DB_URL });

const TODAY = '2026-03-08';

const picks = [
  {
    date: TODAY,
    sport: 'soccer',
    tier: 'vip',
    home_team: 'Villarreal',
    away_team: 'Elche',
    league: 'La Liga',
    prediction: 'Villarreal to Win',
    confidence: 71.4,
    odds: '1.75',
    fixture_id: 'manual-soccer-1',
    status: 'pending',
    is_power_pick: false,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Home Win',
      sport: 'soccer',
      factors: {
        f03_quality: 'Villarreal 4th table, Elche 17th - struggling for survival',
        f12_venue: 'Villarreal dominant at home - max venue pressure',
        f01_market: 'Sharp action on Villarreal home win'
      },
      recommendation: 'Villarreal to Win — 71.4% confidence. Villarreal sits 4th in the table and is dominant at home. Factor 03 (Team Quality) and Factor 12 (Venue Pressure) are at max levels. Elche is currently 17th and struggling for survival.'
    })
  },
  {
    date: TODAY,
    sport: 'soccer',
    tier: 'vip',
    home_team: 'Sevilla',
    away_team: 'Rayo Vallecano',
    league: 'La Liga',
    prediction: 'Over 1.5 Total Goals',
    confidence: 69.5,
    odds: '1.55',
    fixture_id: 'manual-soccer-2',
    status: 'pending',
    is_power_pick: false,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Over 1.5 Total Goals',
      sport: 'soccer',
      factors: {
        f04_h2h: '4 of Sevilla last 5 and all of Rayo last 5 went Over 1.5',
        f03_quality: 'Both teams locked at 30 points, desperate to climb',
        f02_momentum: 'Both teams in attacking form'
      },
      recommendation: 'Over 1.5 Total Goals — 69.5% confidence. Both teams are locked at 30 points and desperate to climb. Factor 04 (H2H History) shows 4 of Sevilla\'s last 5 matches and all of Rayo\'s last 5 have gone over this total.'
    })
  },
  {
    date: TODAY,
    sport: 'soccer',
    tier: 'vip',
    home_team: 'Napoli',
    away_team: 'Monza',
    league: 'Serie A',
    prediction: 'Napoli to Win',
    confidence: 70.2,
    odds: '1.65',
    fixture_id: 'manual-soccer-3',
    status: 'pending',
    is_power_pick: false,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Home Win',
      sport: 'soccer',
      factors: {
        f07_injuries: 'Lukaku and McTominay confirmed fit',
        f01_market: 'Heavy sharp action on Napoli home win',
        f11_standing: 'Napoli in fierce battle for European spots'
      },
      recommendation: 'Napoli to Win — 70.2% confidence. Napoli is in a fierce battle for European spots. Factor 07 (Injuries) confirms Lukaku and McTominay are fit. Factor 01 (Market Consensus) shows heavy sharp action on a home win.'
    })
  }
];

async function run() {
  await client.connect();
  console.log('Connected to DB');

  // First delete any existing manual soccer picks for today to avoid duplicates
  await client.query(`DELETE FROM picks WHERE date = $1 AND fixture_id LIKE 'manual-soccer-%'`, [TODAY]);
  console.log('Cleared old manual soccer picks');

  for (const pick of picks) {
    const result = await client.query(`
      INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      RETURNING id
    `, [
      pick.date, pick.sport, pick.tier, pick.home_team, pick.away_team,
      pick.league, pick.prediction, pick.confidence, pick.odds, pick.fixture_id,
      pick.status, pick.is_power_pick, pick.is_featured, pick.is_disabled, pick.metadata
    ]);
    console.log(`✅ Inserted: ${pick.home_team} vs ${pick.away_team} — ${pick.prediction} @ ${pick.confidence}% [ID: ${result.rows[0].id}]`);
  }

  await client.end();
  console.log('\nAll 3 soccer picks inserted successfully!');
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
