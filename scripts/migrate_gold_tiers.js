/**
 * Migration: Hardened Tier Architecture
 * - Adds v3_audit_passed boolean to picks table
 * - Creates gold_tiers table (isolated branch for Pro/Lifetime picks)
 * - Backfills v3_audit_passed=true for all existing picks with confidence >= 65
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[Migration] Starting Hardened Tier Architecture migration...');

    // 1. Add v3_audit_passed column to picks table (idempotent)
    await client.query(`
      ALTER TABLE picks
      ADD COLUMN IF NOT EXISTS v3_audit_passed boolean NOT NULL DEFAULT false;
    `);
    console.log('[Migration] ✅ Added v3_audit_passed column to picks table');

    // 2. Backfill: mark all existing picks with confidence >= 65 as v3_audit_passed=true
    const backfill = await client.query(`
      UPDATE picks
      SET v3_audit_passed = true
      WHERE confidence >= 65 AND v3_audit_passed = false;
    `);
    console.log(`[Migration] ✅ Backfilled ${backfill.rowCount} picks with v3_audit_passed=true`);

    // 3. Create gold_tiers table — isolated branch for Pro/Lifetime picks
    // This table stores the final hardened tier picks after all threshold gates pass.
    // The tier API endpoints ONLY read from this table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS gold_tiers (
        id            serial PRIMARY KEY,
        date          text NOT NULL,
        sport         text NOT NULL,                          -- soccer | nba | mls
        tier          text NOT NULL,                          -- pro | lifetime
        home_team     text NOT NULL,
        away_team     text NOT NULL,
        league        text NOT NULL DEFAULT '',
        prediction    text NOT NULL,
        confidence    real NOT NULL,
        odds          text DEFAULT '',
        fixture_id    text,
        is_power_pick boolean DEFAULT false,
        is_fallback   boolean DEFAULT false,                  -- true = used 65%/67% fallback floor
        fallback_floor real,                                  -- actual floor used (65 or 67)
        v3_audit_passed boolean NOT NULL DEFAULT true,        -- always true in this table
        sport_slot    text,                                   -- 'nba_1'|'nba_2'|'nba_3'|'soccer_1'...|'extra_1'
        metadata      jsonb,
        created_at    timestamp DEFAULT now(),
        updated_at    timestamp DEFAULT now()
      );
    `);
    console.log('[Migration] ✅ Created gold_tiers table');

    // 4. Create index for fast date+tier lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gold_tiers_date_tier ON gold_tiers (date, tier);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gold_tiers_date ON gold_tiers (date);
    `);
    console.log('[Migration] ✅ Created indexes on gold_tiers');

    // 5. Unique constraint: one pick per (date, home_team, away_team, tier)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'gold_tiers_date_teams_tier_unique'
        ) THEN
          ALTER TABLE gold_tiers
          ADD CONSTRAINT gold_tiers_date_teams_tier_unique
          UNIQUE (date, home_team, away_team, tier);
        END IF;
      END $$;
    `);
    console.log('[Migration] ✅ Added unique constraint on gold_tiers (date, home_team, away_team, tier)');

    console.log('[Migration] 🏆 Hardened Tier Architecture migration complete!');
  } catch (err) {
    console.error('[Migration] ❌ Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
