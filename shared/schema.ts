import { pgTable, text, varchar, integer, boolean, timestamp, real, jsonb, serial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Users / Admin
export const users = pgTable('users', {
  id: varchar('id').primaryKey().default(sql`gen_random_uuid()`),
  username: text('username').notNull().unique(),
  password: text('password').notNull(),
});

// Picks
export const picks = pgTable('picks', {
  id: serial('id').primaryKey(),
  date: text('date').notNull(),
  sport: text('sport').notNull().default('soccer'),
  tier: text('tier').notNull().default('free'), // free | vip | pro
  homeTeam: text('home_team').notNull(),
  awayTeam: text('away_team').notNull(),
  league: text('league'),
  prediction: text('prediction').notNull(),
  confidence: real('confidence').notNull(),
  odds: text('odds'),
  fixtureId: text('fixture_id'),
  status: text('status').notNull().default('pending'), // pending | won | lost | void
  isPowerPick: boolean('is_power_pick').default(false),
  isFeatured: boolean('is_featured').default(false),
  isDisabled: boolean('is_disabled').default(false),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Results / W-L records
export const results = pgTable('results', {
  id: serial('id').primaryKey(),
  pickId: integer('pick_id'),
  date: text('date').notNull(),
  sport: text('sport').notNull(),
  match: text('match').notNull().default(''),
  homeTeam: text('home_team').notNull(),
  awayTeam: text('away_team').notNull(),
  prediction: text('prediction').notNull(),
  confidence: real('confidence'),
  result: text('result').notNull(), // won | lost | void
  tier: text('tier').default('free'),
  actualScore: text('actual_score'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Run logs
export const runLogs = pgTable('run_logs', {
  id: serial('id').primaryKey(),
  date: text('date').notNull(),
  status: text('status').notNull(), // success | failed | running
  picksGenerated: integer('picks_generated').default(0),
  soccerPicks: integer('soccer_picks').default(0),
  nbaPicks: integer('nba_picks').default(0),
  ftpUploaded: boolean('ftp_uploaded').default(false),
  errorMessage: text('error_message'),
  duration: integer('duration'), // ms
  triggeredBy: text('triggered_by').default('scheduler'), // scheduler | manual
  createdAt: timestamp('created_at').defaultNow(),
});

// Members
export const members = pgTable('members', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  username: text('username').unique(),
  passwordHash: text('password_hash'),
  tier: text('tier').notNull().default('free'),         // free | vip | pro | lifetime
  subscriptionPlan: text('subscription_plan'),          // vip-monthly | pro-monthly | lifetime
  token: text('token'),
  lastActive: timestamp('last_active'),
  expiresAt: timestamp('expires_at'),                   // null = lifetime / never expires
  tierLockedUntil: timestamp('tier_locked_until'),      // cannot downgrade/switch until this date
  isActive: boolean('is_active').default(true),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Member heartbeats
export const memberHeartbeats = pgTable('member_heartbeats', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  page: text('page'),
  timestamp: timestamp('timestamp').defaultNow(),
});

// Parlays
export const parlays = pgTable('parlays', {
  id: serial('id').primaryKey(),
  date: text('date').notNull(),
  type: text('type').notNull(), // soccer | nba | conservative
  legs: jsonb('legs').notNull(),
  totalOdds: text('total_odds'),
  isOverride: boolean('is_override').default(false),
  isDisabled: boolean('is_disabled').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// System alerts
export const systemAlerts = pgTable('system_alerts', {
  id: serial('id').primaryKey(),
  level: text('level').notNull(), // info | warning | critical
  message: text('message').notNull(),
  resolved: boolean('resolved').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

// Engine calibration weights
export const engineConfig = pgTable('engine_config', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Audit reports
export const auditReports = pgTable('audit_reports', {
  id: serial('id').primaryKey(),
  weekStart: text('week_start').notNull(),
  weekEnd: text('week_end').notNull(),
  totalPicks: integer('total_picks').default(0),
  wins: integer('wins').default(0),
  losses: integer('losses').default(0),
  winRate: real('win_rate').default(0),
  reportData: jsonb('report_data'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Player stats
export const playerStats = pgTable('player_stats', {
  id: serial('id').primaryKey(),
  date: text('date').notNull(),
  sport: text('sport').notNull(),
  playerId: text('player_id'),
  playerName: text('player_name').notNull(),
  team: text('team'),
  stats: jsonb('stats'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Tier pricing config
export const tierPricing = pgTable('tier_pricing', {
  id: serial('id').primaryKey(),
  tier: text('tier').notNull().unique(),
  price: real('price').notNull(),
  label: text('label'),
  features: jsonb('features'),
  updatedAt: timestamp('updated_at').defaultNow(),
});
