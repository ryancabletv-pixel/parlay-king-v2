import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const TODAY = '2026-03-08';

// Clear old manual MLS and power picks
await client.query("DELETE FROM picks WHERE date = $1 AND fixture_id LIKE 'manual-mls-%'", [TODAY]);
await client.query("DELETE FROM picks WHERE date = $1 AND fixture_id LIKE 'manual-power-%'", [TODAY]);
console.log('Cleared old MLS and power picks');

// MLS Pick 1 - NY Red Bulls vs CF Montreal
const meta1 = {
  topPick: 'Home Win', sport: 'mls',
  factors: {
    f02_momentum: 'Red Bulls 2-0-0 to start season; Montreal 0-0-2, outscored 8-0',
    f03_quality: '17-year-old Julian Hall in blistering form (3 goals in 177 mins)',
    f12_venue: 'Home at Harrison, massive advantage vs Montreal who has not found rhythm'
  },
  recommendation: 'New York Red Bulls to Win — 73.8% confidence. Red Bulls are 2-0-0 to start the season. Montreal is 0-0-2 and has been outscored 8-0. Julian Hall in blistering form. Market probability is higher than odds suggest due to Montreal defensive collapse.'
};
const r1 = await client.query(
  `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
   VALUES ($1,'mls','pro','New York Red Bulls','CF Montréal','MLS','New York Red Bulls to Win',73.8,'1.62','manual-mls-1','pending',false,false,false,$2::jsonb)
   RETURNING id`,
  [TODAY, JSON.stringify(meta1)]
);
console.log('MLS Pick 1 inserted, ID:', r1.rows[0].id);

// MLS Pick 2 - FC Cincinnati vs Toronto FC
const meta2 = {
  topPick: 'Home Win', sport: 'mls',
  factors: {
    f04_h2h: 'Cincinnati won 4 of last 5 home meetings vs Toronto',
    f07_injuries: 'Toronto missing 6+ key rotation players incl. Gomis and Corbeanu',
    f11_standing: 'Cincinnati 5th and moving up; Toronto 12th with early defensive leaks'
  },
  recommendation: 'FC Cincinnati to Win — 71.5% confidence. Cincinnati has won 4 of the last 5 home meetings against Toronto. Toronto FC is missing at least 6 key rotation players. Cincinnati defensive structure perfectly counters Toronto transitional style.'
};
const r2 = await client.query(
  `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
   VALUES ($1,'mls','vip','FC Cincinnati','Toronto FC','MLS','FC Cincinnati to Win',71.5,'1.75','manual-mls-2','pending',false,false,false,$2::jsonb)
   RETURNING id`,
  [TODAY, JSON.stringify(meta2)]
);
console.log('MLS Pick 2 inserted, ID:', r2.rows[0].id);

// Power Pick - NY Red Bulls (highest confidence play of the day)
const metaPP = {
  topPick: 'Home Win', sport: 'mls',
  recommendation: 'POWER PICK — Red Bulls Moneyline 73.8% confidence. Safest play on the MLS board. Montreal has not scored a single goal in 2026. The 12-factor engine sees almost zero chance of an upset. Red Bulls 2-0-0, Montreal 0-0-2 outscored 8-0.'
};
const r3 = await client.query(
  `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
   VALUES ($1,'mls','pro','New York Red Bulls','CF Montréal','MLS','Red Bulls Moneyline',73.8,'1.62','manual-power-1','pending',true,true,false,$2::jsonb)
   RETURNING id`,
  [TODAY, JSON.stringify(metaPP)]
);
console.log('Power Pick inserted, ID:', r3.rows[0].id);

await client.end();
console.log('\nAll MLS picks + Power Pick inserted successfully!');
