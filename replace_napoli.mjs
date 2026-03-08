import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const TODAY = '2026-03-08';

// Delete Napoli vs Monza
const del = await client.query(
  "DELETE FROM picks WHERE date = $1 AND home_team = 'Napoli' AND away_team = 'Monza'",
  [TODAY]
);
console.log('Deleted Napoli vs Monza:', del.rowCount, 'row(s)');

// Insert Lens vs Metz
const ins = await client.query(
  `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
   VALUES ($1,'soccer','pro','Lens','Metz','Ligue 1','Lens to Win',70.2,'1.68','manual-soccer-3','pending',false,false,false,$2::jsonb)
   RETURNING id`,
  [TODAY, JSON.stringify({
    topPick: 'Home Win',
    sport: 'soccer',
    factors: {
      f03_quality: 'Lens significantly stronger than relegated-threatened Metz',
      f12_venue: 'Lens at home — Stade Bollaert-Delelis provides strong home advantage',
      f11_standing: 'Lens mid-table pushing for Europe; Metz bottom half fighting relegation'
    },
    recommendation: 'Lens to Win (Moneyline) — 70.2% confidence. Lens at home vs Metz in Ligue 1. Lens significantly stronger and playing at Stade Bollaert-Delelis. Metz struggling in the lower half of the table.'
  })]
);
console.log('Inserted Lens vs Metz, ID:', ins.rows[0].id);

// Verify current soccer picks
const picks = await client.query(
  "SELECT id, home_team, away_team, prediction, confidence FROM picks WHERE date = $1 AND sport = 'soccer' ORDER BY confidence DESC",
  [TODAY]
);
console.log('\n=== SOCCER PICKS FOR', TODAY, '===');
for (const row of picks.rows) {
  console.log(`  [${row.id}] ${row.home_team} vs ${row.away_team} | ${row.prediction} @ ${row.confidence}%`);
}

await client.end();
console.log('Done!');
