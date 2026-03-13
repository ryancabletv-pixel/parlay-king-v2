require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const today = '2026-03-13';

  // Step 1: Show all today's picks
  const all = await pool.query(
    `SELECT id, home_team, away_team, sport, confidence, tier, is_power_pick, is_featured
     FROM picks WHERE date = $1 ORDER BY confidence DESC`,
    [today]
  );
  
  console.log(`\n=== ALL PICKS FOR ${today} (${all.rows.length} total) ===`);
  all.rows.forEach(p => {
    console.log(`  ID:${p.id} ${(p.sport||'').padEnd(6)} ${(p.confidence||0)}% tier:${(p.tier||'').padEnd(10)} ${p.home_team} vs ${p.away_team}`);
  });

  // Step 2: Apply hardened tier logic
  // PRO:      confidence >= 68%, max 6, soccer+nba only
  // LIFETIME: confidence >= 70%, max 10, unique extra picks beyond Pro

  const eligible = all.rows.filter(p => ['soccer','nba','mls'].includes(p.sport));

  // Reset all today's picks to 'free'
  await pool.query(`UPDATE picks SET tier = 'free' WHERE date = $1`, [today]);

  // Mark 68-69.9% as 'pro' only
  const proOnly = await pool.query(
    `UPDATE picks SET tier = 'pro' WHERE date = $1 AND confidence >= 68 AND confidence < 70 AND sport IN ('soccer','nba','mls') RETURNING id, sport, confidence, home_team, away_team`,
    [today]
  );

  // Mark 70%+ as 'lifetime' (also visible to pro since pro queries >= 68%)
  const lifetimeOnly = await pool.query(
    `UPDATE picks SET tier = 'lifetime' WHERE date = $1 AND confidence >= 70 AND sport IN ('soccer','nba','mls') RETURNING id, sport, confidence, home_team, away_team`,
    [today]
  );

  console.log(`\n=== TIER ASSIGNMENT COMPLETE ===`);
  console.log(`  Pro-only (68-69%): ${proOnly.rows.length} picks`);
  console.log(`  Lifetime (70%+):   ${lifetimeOnly.rows.length} picks`);

  // Step 3: Show the two distinct views
  // Pro sees: tier='pro' OR tier='lifetime' where confidence >= 68, max 6
  const proView = await pool.query(
    `SELECT id, sport, confidence, tier, home_team, away_team FROM picks 
     WHERE date = $1 AND tier IN ('pro','lifetime') AND confidence >= 68 AND sport IN ('soccer','nba','mls')
     ORDER BY confidence DESC LIMIT 6`,
    [today]
  );

  // Lifetime sees: tier='lifetime' where confidence >= 70, max 10
  const lifetimeView = await pool.query(
    `SELECT id, sport, confidence, tier, home_team, away_team FROM picks 
     WHERE date = $1 AND tier = 'lifetime' AND confidence >= 70 AND sport IN ('soccer','nba','mls')
     ORDER BY confidence DESC LIMIT 10`,
    [today]
  );

  console.log(`\n=== PRO TIER VIEW (${proView.rows.length}/6 picks, 68%+ threshold) ===`);
  proView.rows.forEach((p,i) => {
    const tag = p.tier === 'pro' ? '[PRO EXCLUSIVE]' : '[SHARED w/ Lifetime]';
    console.log(`  ${i+1}. ${(p.sport||'').padEnd(6)} ${p.confidence}% ${p.home_team} vs ${p.away_team} ${tag}`);
  });

  console.log(`\n=== LIFETIME TIER VIEW (${lifetimeView.rows.length}/10 picks, 70%+ threshold) ===`);
  lifetimeView.rows.forEach((p,i) => {
    const inPro = proView.rows.some(x => x.id === p.id);
    const tag = inPro ? '[also in Pro]' : '[LIFETIME EXCLUSIVE]';
    console.log(`  ${i+1}. ${(p.sport||'').padEnd(6)} ${p.confidence}% ${p.home_team} vs ${p.away_team} ${tag}`);
  });

  const proIds = new Set(proView.rows.map(p => p.id));
  const lifetimeIds = new Set(lifetimeView.rows.map(p => p.id));
  const identical = [...proIds].every(id => lifetimeIds.has(id)) && [...lifetimeIds].every(id => proIds.has(id));
  console.log(`\nAre they identical? ${identical ? 'YES — need more picks for separation' : 'NO — tiers are correctly separated'}`);

  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
