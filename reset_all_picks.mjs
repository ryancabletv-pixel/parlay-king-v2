import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const TODAY = '2026-03-08';

// Step 1: Clear ALL picks for today
await client.query("DELETE FROM picks WHERE date = $1", [TODAY]);
console.log('Cleared all picks for', TODAY);

// Helper to insert a pick
async function insertPick({ sport, tier, home, away, league, prediction, confidence, odds, fixtureId, isPower, isFeatured, metadata }) {
  const r = await client.query(
    `INSERT INTO picks (date, sport, tier, home_team, away_team, league, prediction, confidence, odds, fixture_id, status, is_power_pick, is_featured, is_disabled, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,false,$13::jsonb)
     RETURNING id`,
    [TODAY, sport, tier, home, away, league, prediction, confidence, odds, fixtureId, isPower||false, isFeatured||false, JSON.stringify(metadata||{})]
  );
  return r.rows[0].id;
}

// ===== SOCCER 3-LEG PARLAY =====
const s1 = await insertPick({
  sport:'soccer', tier:'pro', home:'Villarreal', away:'Elche', league:'La Liga',
  prediction:'Villarreal to Win', confidence:71.4, odds:'1.72', fixtureId:'manual-soccer-1',
  metadata:{
    topPick:'Home Win', sport:'soccer',
    factors:{
      f03_quality:'Villarreal 4th in table, dominant at home; Elche 17th, struggling for survival',
      f12_venue:'Factor 12 Venue Pressure at max levels for Villarreal at home'
    },
    recommendation:'Villarreal to Win — 71.4% confidence. Villarreal sits 4th in the table and is dominant at home. Elche is currently 17th and struggling for survival. Factor 03 (Team Quality) and Factor 12 (Venue Pressure) are at max levels.'
  }
});
console.log('Soccer 1 inserted, ID:', s1);

const s2 = await insertPick({
  sport:'soccer', tier:'pro', home:'Sevilla', away:'Rayo Vallecano', league:'La Liga',
  prediction:'Over 1.5 Total Goals', confidence:69.5, odds:'1.45', fixtureId:'manual-soccer-2',
  metadata:{
    topPick:'Over 1.5 Goals', sport:'soccer',
    factors:{
      f04_h2h:'4 of Sevillas last 5 matches and all of Rayos last 5 have gone over this total',
      f02_momentum:'Both teams locked at 30 points and desperate to climb'
    },
    recommendation:'Over 1.5 Total Goals — 69.5% confidence. Both teams are locked at 30 points and desperate to climb. Factor 04 (H2H History) shows that 4 of Sevillas last 5 matches and all of Rayos last 5 have gone over this total.'
  }
});
console.log('Soccer 2 inserted, ID:', s2);

const s3 = await insertPick({
  sport:'soccer', tier:'pro', home:'Napoli', away:'Monza', league:'Serie A',
  prediction:'Napoli to Win', confidence:70.2, odds:'1.55', fixtureId:'manual-soccer-3',
  metadata:{
    topPick:'Home Win', sport:'soccer',
    factors:{
      f07_injuries:'Lukaku and McTominay confirmed fit for Napoli',
      f01_market:'Heavy sharp action on home win — Factor 01 Market Consensus strong',
      f03_quality:'Napoli in fierce battle for European spots'
    },
    recommendation:'Napoli to Win — 70.2% confidence. Napoli is currently in a fierce battle for European spots. Factor 07 (Injuries) confirms Lukaku and McTominay are fit. Factor 01 (Market Consensus) shows heavy sharp action on a home win.'
  }
});
console.log('Soccer 3 inserted, ID:', s3);

// ===== NBA 3-LEG PARLAY =====
const n1 = await insertPick({
  sport:'nba', tier:'pro', home:'Milwaukee Bucks', away:'Orlando Magic', league:'NBA',
  prediction:'Milwaukee Bucks Moneyline', confidence:74.3, odds:'1.48', fixtureId:'manual-nba-1',
  metadata:{
    topPick:'Home Win', sport:'nba',
    factors:{
      f12_venue:'Fiserv Forum Factor 12 Venue Pressure elite even with Giannis on limited minutes',
      f03_quality:'Bucks frontcourt depth (Portis/Kuzma) gives massive edge; Orlando defensive discipline poor on road'
    },
    recommendation:'Milwaukee Bucks Moneyline — 74.3% confidence. Highest-rated NBA play today. Even with Giannis returning from a calf strain on limited minutes, the Bucks Factor 12 (Venue Pressure) at Fiserv Forum remains elite. Orlando has struggled with defensive discipline on the road.'
  }
});
console.log('NBA 1 inserted, ID:', n1);

const n2 = await insertPick({
  sport:'nba', tier:'pro', home:'LA Lakers', away:'New York Knicks', league:'NBA',
  prediction:'New York Knicks Moneyline', confidence:72.6, odds:'1.65', fixtureId:'manual-nba-2',
  isFeatured:true,
  metadata:{
    topPick:'Away Win', sport:'nba', megaPick:true, gameTime:'3:30 PM ET / 4:30 PM AST',
    factors:{
      f02_momentum:'Knicks coming off dominant 142-103 win in Denver',
      f07_injuries:'Lakers struggling with depth; Knicks core (Brunson, Towns, Bridges) fully healthy and in peak sync',
      f01_market:'Heavy sharp money moved line from -2.5 to -3.5 — high professional confidence in Knicks'
    },
    recommendation:'Sunday Featured Mega-Pick — New York Knicks Moneyline @ 72.6% confidence. Knicks coming off a dominant 142-103 win in Denver. Lakers struggling with depth while Knicks core (Brunson, Towns, Bridges) is fully healthy. Sharp money has moved the line from -2.5 to -3.5.'
  }
});
console.log('NBA 2 (Featured Mega-Pick) inserted, ID:', n2);

const n3 = await insertPick({
  sport:'nba', tier:'pro', home:'Miami Heat', away:'Detroit Pistons', league:'NBA',
  prediction:'Miami Heat Moneyline', confidence:70.5, odds:'1.55', fixtureId:'manual-nba-3',
  metadata:{
    topPick:'Home Win', sport:'nba',
    factors:{
      f06_rest:'Heat have significant rest advantage',
      f07_injuries:'Detroit Cade Cunningham still fighting quad contusion; Miami Andrew Wiggins expected back',
      f04_q4:'Heat tactical discipline in 4th quarter is the Secret Sauce'
    },
    recommendation:'Miami Heat Moneyline — 70.5% confidence. Secret Sauce play. Heat have significant Factor 06 (Rest Advantage). Detroit Cade Cunningham is still fighting a quad contusion while Miami Andrew Wiggins is expected back. The Heats tactical discipline in the 4th quarter puts this well over the 68% threshold.'
  }
});
console.log('NBA 3 inserted, ID:', n3);

// ===== MLS 2-PICK =====
const m1 = await insertPick({
  sport:'mls', tier:'pro', home:'New York Red Bulls', away:'CF Montréal', league:'MLS',
  prediction:'New York Red Bulls to Win', confidence:73.8, odds:'1.62', fixtureId:'manual-mls-1',
  metadata:{
    topPick:'Home Win', sport:'mls',
    factors:{
      f02_momentum:'Red Bulls 2-0-0 to start season; Montreal 0-0-2, outscored 8-0',
      f03_quality:'17-year-old Julian Hall in blistering form (3 goals in 177 mins)',
      f12_venue:'Home at Harrison, massive advantage vs Montreal who has not found rhythm'
    },
    recommendation:'New York Red Bulls to Win — 73.8% confidence. Red Bulls are 2-0-0 to start the season. Montreal is 0-0-2 and has been outscored 8-0. Julian Hall in blistering form. Market probability is higher than odds suggest due to Montreal defensive collapse.'
  }
});
console.log('MLS 1 inserted, ID:', m1);

const m2 = await insertPick({
  sport:'mls', tier:'pro', home:'FC Cincinnati', away:'Toronto FC', league:'MLS',
  prediction:'FC Cincinnati to Win', confidence:71.5, odds:'1.75', fixtureId:'manual-mls-2',
  metadata:{
    topPick:'Home Win', sport:'mls',
    factors:{
      f04_h2h:'Cincinnati won 4 of last 5 home meetings vs Toronto',
      f07_injuries:'Toronto missing 6+ key rotation players incl. Gomis and Corbeanu',
      f11_standing:'Cincinnati 5th and moving up; Toronto 12th with early defensive leaks'
    },
    recommendation:'FC Cincinnati to Win — 71.5% confidence. Cincinnati has won 4 of the last 5 home meetings against Toronto. Toronto FC is missing at least 6 key rotation players. Cincinnati defensive structure perfectly counters Toronto transitional style.'
  }
});
console.log('MLS 2 inserted, ID:', m2);

// ===== POWER PICK (NY Red Bulls — highest MLS confidence) =====
const pp = await insertPick({
  sport:'mls', tier:'pro', home:'New York Red Bulls', away:'CF Montréal', league:'MLS',
  prediction:'Red Bulls Moneyline', confidence:73.8, odds:'1.62', fixtureId:'manual-power-1',
  isPower:true,
  metadata:{
    topPick:'Home Win', sport:'mls',
    recommendation:'POWER PICK — Red Bulls Moneyline 73.8% confidence. Safest play on the MLS board. Montreal has not scored a single goal in 2026. The 12-factor engine sees almost zero chance of an upset. Red Bulls 2-0-0, Montreal 0-0-2 outscored 8-0.'
  }
});
console.log('Power Pick inserted, ID:', pp);

// ===== VERIFY =====
const all = await client.query(
  "SELECT id, sport, home_team, away_team, prediction, confidence, is_power_pick, is_featured FROM picks WHERE date = $1 ORDER BY sport, confidence DESC",
  [TODAY]
);
console.log('\n=== ALL PICKS FOR', TODAY, '===');
for (const row of all.rows) {
  const tags = [];
  if (row.is_power_pick) tags.push('[POWER]');
  if (row.is_featured) tags.push('[FEATURED]');
  console.log(`  ${row.sport.toUpperCase()} | ${row.home_team} vs ${row.away_team} | ${row.prediction} @ ${row.confidence}% ${tags.join(' ')}`);
}
console.log('\nTotal picks:', all.rows.length);

await client.end();
console.log('Done!');
