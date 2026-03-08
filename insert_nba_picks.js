import pg from 'pg';
const { Client } = pg;

const DB_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_WPim3gY4lKTj@ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require';
const client = new Client({ connectionString: DB_URL });
const TODAY = '2026-03-08';

const picks = [
  {
    date: TODAY,
    sport: 'nba',
    tier: 'pro',
    home_team: 'Milwaukee Bucks',
    away_team: 'Orlando Magic',
    league: 'NBA',
    prediction: 'Milwaukee Bucks Moneyline',
    confidence: 74.3,
    odds: '1.72',
    fixture_id: 'manual-nba-1',
    status: 'pending',
    is_power_pick: true,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Home Win',
      sport: 'nba',
      factors: {
        f12_venue: 'Fiserv Forum elite home pressure',
        f03_quality: 'Bucks frontcourt depth (Portis/Kuzma) massive edge',
        f07_injuries: 'Giannis returning from calf strain on limited minutes',
        f02_momentum: 'Orlando struggling with defensive discipline on road'
      },
      recommendation: 'Milwaukee Bucks Moneyline — 74.3% confidence. Highest-rated NBA play today. Bucks Factor 12 (Venue Pressure) at Fiserv Forum remains elite. Orlando has struggled with defensive discipline on the road. Bucks frontcourt depth gives massive edge in Factor 03 (Team Quality).'
    })
  },
  {
    date: TODAY,
    sport: 'nba',
    tier: 'vip',
    home_team: 'LA Lakers',
    away_team: 'New York Knicks',
    league: 'NBA',
    prediction: 'Over 227.5 Total Points',
    confidence: 69.1,
    odds: '1.91',
    fixture_id: 'manual-nba-2',
    status: 'pending',
    is_power_pick: false,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Over 227.5 Total Points',
      sport: 'nba',
      factors: {
        f04_h2h: 'H2H history strongly supports Over',
        f05_steam: 'Sharp market steam on the Over',
        f02_momentum: 'Luka Doncic leading league in scoring, Brunson off 40-pt game',
        f03_quality: 'Lakers defense allowing 115+ points consistently'
      },
      recommendation: 'Over 227.5 Total Points — 69.1% confidence. Lakers defense has been porous, allowing 115+ points consistently. With Luka Doncic leading the league in scoring and Jalen Brunson coming off a 40-point performance, offensive momentum (Factor 02) makes the Over the statistically superior play.'
    })
  },
  {
    date: TODAY,
    sport: 'nba',
    tier: 'vip',
    home_team: 'Miami Heat',
    away_team: 'Detroit Pistons',
    league: 'NBA',
    prediction: 'Miami Heat Moneyline',
    confidence: 70.5,
    odds: '2.08',
    fixture_id: 'manual-nba-3',
    status: 'pending',
    is_power_pick: false,
    is_featured: false,
    is_disabled: false,
    metadata: JSON.stringify({
      topPick: 'Home Win',
      sport: 'nba',
      factors: {
        f06_rest: 'Heat have significant rest advantage',
        f07_injuries: "Detroit's Cade Cunningham fighting quad contusion, Miami's Andrew Wiggins expected back",
        f09_tactical: 'Heat tactical discipline in 4th quarter'
      },
      recommendation: "Miami Heat Moneyline — 70.5% confidence. Secret Sauce play. Heat have significant Factor 06 (Rest Advantage). Detroit's Cade Cunningham still fighting a quad contusion while Miami's Andrew Wiggins is expected back. Heat's tactical discipline in the 4th quarter puts this well over the 68% threshold."
    })
  }
];

async function run() {
  await client.connect();
  console.log('Connected to DB');

  // Clear any existing manual NBA picks for today
  await client.query(`DELETE FROM picks WHERE date = $1 AND fixture_id LIKE 'manual-nba-%'`, [TODAY]);
  console.log('Cleared old manual NBA picks');

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
    console.log(`✅ Inserted: ${pick.away_team} @ ${pick.home_team} — ${pick.prediction} @ ${pick.confidence}% [ID: ${result.rows[0].id}]`);
  }

  await client.end();
  console.log('\nAll 3 NBA picks inserted successfully!');
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
