/**
 * Populate gold_tiers table for today's date using hardened tier logic.
 * Run: node scripts/populate_gold_tiers.js [YYYY-MM-DD]
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const HARDENED_TIER_CONFIG = {
  pro: {
    totalPicks: 6, nbaSlots: 3, soccerSlots: 3, extraSlots: 0,
    primaryThresh: 68, fallbackFloor: 65, extraThresh: 68,
  },
  lifetime: {
    totalPicks: 10, nbaSlots: 3, soccerSlots: 4, extraSlots: 3,
    primaryThresh: 70, fallbackFloor: 67, extraThresh: 70,
  },
};

async function run() {
  const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  console.log('[GoldTiers] Building gold_tiers for date:', date);

  const { rows: allPicks } = await pool.query(
    `SELECT * FROM picks WHERE date = $1 AND is_disabled = false AND v3_audit_passed = true AND sport IN ('soccer','nba','mls') ORDER BY confidence DESC`,
    [date]
  );
  console.log('[GoldTiers] Eligible picks (v3_audit_passed=true):', allPicks.length);

  await pool.query('DELETE FROM gold_tiers WHERE date = $1', [date]);

  const nbaPicks    = allPicks.filter(p => p.sport === 'nba');
  const soccerPicks = allPicks.filter(p => p.sport === 'soccer' || p.sport === 'mls');
  console.log('[GoldTiers] NBA picks:', nbaPicks.length, '| Soccer picks:', soccerPicks.length);

  for (const [tierName, cfg] of Object.entries(HARDENED_TIER_CONFIG)) {
    const { primaryThresh, fallbackFloor, nbaSlots, soccerSlots, extraSlots, extraThresh } = cfg;

    // NBA slots
    let nbaSelected = nbaPicks.filter(p => p.confidence >= primaryThresh).slice(0, nbaSlots);
    if (nbaSelected.length < nbaSlots) {
      const needed = nbaSlots - nbaSelected.length;
      const ids = new Set(nbaSelected.map(p => p.id));
      const fallback = nbaPicks.filter(p => p.confidence >= fallbackFloor && p.confidence < primaryThresh && !ids.has(p.id));
      nbaSelected = [...nbaSelected, ...fallback.slice(0, needed)];
    }

    // Soccer slots
    let soccerSelected = soccerPicks.filter(p => p.confidence >= primaryThresh).slice(0, soccerSlots);
    if (soccerSelected.length < soccerSlots) {
      const needed = soccerSlots - soccerSelected.length;
      const ids = new Set(soccerSelected.map(p => p.id));
      const fallback = soccerPicks.filter(p => p.confidence >= fallbackFloor && p.confidence < primaryThresh && !ids.has(p.id));
      soccerSelected = [...soccerSelected, ...fallback.slice(0, needed)];
    }

    // Extra slots (any sport >= extraThresh, not already selected)
    const alreadyIds = new Set([...nbaSelected, ...soccerSelected].map(p => p.id));
    let extraSelected = [];
    if (extraSlots > 0) {
      extraSelected = allPicks.filter(p => p.confidence >= extraThresh && !alreadyIds.has(p.id)).slice(0, extraSlots);
    }

    const allSelected = [...nbaSelected, ...soccerSelected, ...extraSelected];

    for (const p of allSelected) {
      const nbaIdx    = nbaSelected.indexOf(p);
      const soccerIdx = soccerSelected.indexOf(p);
      const extraIdx  = extraSelected.indexOf(p);
      const sportSlot = nbaIdx >= 0    ? `nba_${nbaIdx + 1}`
                      : soccerIdx >= 0 ? `soccer_${soccerIdx + 1}`
                      : `extra_${extraIdx + 1}`;
      const isFallback = p.confidence < primaryThresh;

      await pool.query(
        `INSERT INTO gold_tiers
         (date, sport, tier, home_team, away_team, league, prediction, confidence, odds,
          fixture_id, is_power_pick, is_fallback, fallback_floor, v3_audit_passed, sport_slot, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15)
         ON CONFLICT (date, home_team, away_team, tier) DO UPDATE SET
           confidence  = EXCLUDED.confidence,
           prediction  = EXCLUDED.prediction,
           is_fallback = EXCLUDED.is_fallback,
           sport_slot  = EXCLUDED.sport_slot,
           updated_at  = now()`,
        [
          date, p.sport, tierName, p.home_team, p.away_team, p.league || '',
          p.prediction, p.confidence, p.odds || '', p.fixture_id,
          p.is_power_pick || false, isFallback, isFallback ? fallbackFloor : null,
          sportSlot, p.metadata || null,
        ]
      );
    }

    const fallbackCount = allSelected.filter(p => p.confidence < primaryThresh).length;
    console.log(`[GoldTiers] ${tierName.toUpperCase()}: ${allSelected.length}/${cfg.totalPicks} picks | NBA=${nbaSelected.length}/${nbaSlots} Soccer=${soccerSelected.length}/${soccerSlots} Extra=${extraSelected.length}/${extraSlots}${fallbackCount > 0 ? ` [${fallbackCount} FALLBACK]` : ''}`);
  }

  // Print final table
  const { rows: final } = await pool.query(
    `SELECT tier, sport, sport_slot, home_team, away_team, confidence, is_fallback, fallback_floor
     FROM gold_tiers WHERE date = $1 ORDER BY tier, sport_slot`,
    [date]
  );

  console.log('\n=== GOLD TIERS TABLE ===');
  for (const r of final) {
    const fallbackNote = r.is_fallback ? ` [FALLBACK floor=${r.fallback_floor}%]` : '';
    console.log(`[${r.tier.toUpperCase()}] ${r.sport_slot} | ${r.sport.toUpperCase()} | ${r.home_team} vs ${r.away_team} | ${parseFloat(r.confidence).toFixed(1)}%${fallbackNote}`);
  }

  const proCount      = final.filter(r => r.tier === 'pro').length;
  const lifetimeCount = final.filter(r => r.tier === 'lifetime').length;
  console.log(`\n✅ Pro: ${proCount}/6 picks | Lifetime: ${lifetimeCount}/10 picks`);

  await pool.end();
}

run().catch(err => {
  console.error('[GoldTiers] Error:', err.message);
  process.exit(1);
});
