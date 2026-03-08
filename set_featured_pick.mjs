import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const TODAY = '2026-03-08';

// Step 1: Clear is_featured flag from all today's picks
await client.query("UPDATE picks SET is_featured = false WHERE date = $1", [TODAY]);
console.log('Cleared all featured flags for today');

// Step 2: Update the existing LA Lakers vs NY Knicks pick to be featured + update metadata with Mega-Pick details
const metaMega = {
  topPick: 'Away Win',
  sport: 'nba',
  megaPick: true,
  gameTime: '3:30 PM ET / 4:30 PM AST',
  factors: {
    f02_momentum: 'Knicks coming off dominant 142-103 win in Denver',
    f07_injuries: 'Lakers struggling with depth; Knicks core (Brunson, Towns, Bridges) fully healthy and in peak sync',
    f01_market: 'Heavy sharp money moved line from -2.5 to -3.5 — high professional confidence in Knicks'
  },
  recommendation: "Sunday Featured Mega-Pick — New York Knicks Moneyline @ 72.6% confidence. Knicks coming off a dominant 142-103 win in Denver. Lakers struggling with depth while Knicks core (Brunson, Towns, Bridges) is fully healthy. Sharp money has moved the line from -2.5 to -3.5, signaling high professional confidence in the Knicks."
};

// Update the existing Lakers vs Knicks pick (fixture_id = manual-nba-2)
const r = await client.query(
  `UPDATE picks SET 
    is_featured = true,
    confidence = 72.6,
    prediction = 'New York Knicks Moneyline',
    home_team = 'LA Lakers',
    away_team = 'New York Knicks',
    metadata = $1::jsonb
   WHERE date = $2 AND fixture_id = 'manual-nba-2'
   RETURNING id, home_team, away_team, prediction, confidence`,
  [JSON.stringify(metaMega), TODAY]
);

if (r.rows.length > 0) {
  const p = r.rows[0];
  console.log(`Updated Featured Mega-Pick: ${p.home_team} vs ${p.away_team} — ${p.prediction} @ ${p.confidence}% [ID: ${p.id}]`);
} else {
  // If not found, insert a new featured pick
  const r2 = await client.query(
    `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
     VALUES ($1,'nba','pro','LA Lakers','New York Knicks','NBA','New York Knicks Moneyline',72.6,'1.65','manual-nba-featured','pending',false,true,false,$2::jsonb)
     RETURNING id`,
    [TODAY, JSON.stringify(metaMega)]
  );
  console.log('Inserted new Featured Mega-Pick, ID:', r2.rows[0].id);
}

// Verify all featured picks
const check = await client.query(
  "SELECT id, home_team, away_team, sport, prediction, confidence, is_featured, is_power_pick FROM picks WHERE date = $1 AND (is_featured = true OR is_power_pick = true) ORDER BY confidence DESC",
  [TODAY]
);
console.log('\nFeatured/Power picks:');
for (const row of check.rows) {
  const tag = row.is_power_pick ? '[POWER]' : '[FEATURED]';
  console.log(`  ${tag} ${row.home_team} vs ${row.away_team} | ${row.prediction} @ ${row.confidence}%`);
}

await client.end();
console.log('\nDone!');
