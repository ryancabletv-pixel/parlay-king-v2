#!/usr/bin/env node
/**
 * Migration: Create upcoming_fixtures table for free fixture scraper
 * No paid API credits used — data sourced from ESPN/BBC free endpoints
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
    console.log('Creating upcoming_fixtures table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS upcoming_fixtures (
        id            SERIAL PRIMARY KEY,
        sport         VARCHAR(20)  NOT NULL,          -- 'nba' | 'soccer'
        league        VARCHAR(100) NOT NULL,
        home_team     VARCHAR(100) NOT NULL,
        away_team     VARCHAR(100) NOT NULL,
        game_date     DATE         NOT NULL,
        game_time     VARCHAR(20),                    -- e.g. '7:30 PM ET'
        game_datetime TIMESTAMPTZ,                    -- UTC kickoff time
        source        VARCHAR(50)  DEFAULT 'espn',    -- 'espn' | 'bbc'
        external_id   VARCHAR(100),                   -- ESPN game ID
        status        VARCHAR(20)  DEFAULT 'scheduled', -- scheduled|live|final
        -- V3-15 analysis cache
        analyzed      BOOLEAN      DEFAULT FALSE,
        analysis_result JSONB,                        -- cached V3-15 result
        analysis_score  NUMERIC(5,2),                 -- confidence score
        analysis_pass   BOOLEAN,                      -- pass/fail at 65% floor
        analyzed_at   TIMESTAMPTZ,
        -- metadata
        raw_data      JSONB,                          -- raw ESPN response
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      );
    `);

    // Indexes for fast lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_upcoming_fixtures_date
        ON upcoming_fixtures (game_date);
      CREATE INDEX IF NOT EXISTS idx_upcoming_fixtures_sport_date
        ON upcoming_fixtures (sport, game_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_upcoming_fixtures_unique
        ON upcoming_fixtures (sport, home_team, away_team, game_date);
    `);

    console.log('✅ upcoming_fixtures table created with indexes');
    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
