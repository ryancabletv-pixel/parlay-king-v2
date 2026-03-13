import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import * as schema from '../shared/schema.js';

// Database connection pool
let pool: Pool;
let db: ReturnType<typeof drizzle>;

export function getDb() {
  if (!db) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    db = drizzle(pool, { schema });
  }
  return db;
}

// ─── Picks ────────────────────────────────────────────────────────────────────
export async function getPicksByDate(date: string) {
  const db = getDb();
  // Only return active (non-disabled) picks — prevents stale/old picks from inflating counts
  return db.select().from(schema.picks).where(and(eq(schema.picks.date, date), eq(schema.picks.isDisabled, false))).orderBy(desc(schema.picks.confidence));
}

export async function getAllPicks(limit = 100) {
  const db = getDb();
  return db.select().from(schema.picks).orderBy(desc(schema.picks.createdAt)).limit(limit);
}

export async function createPick(data: typeof schema.picks.$inferInsert) {
  const db = getDb();
  const [pick] = await db.insert(schema.picks).values(data).returning();
  return pick;
}

export async function updatePick(id: number, data: Partial<typeof schema.picks.$inferInsert>) {
  const db = getDb();
  const [pick] = await db.update(schema.picks).set({ ...data, updatedAt: new Date() }).where(eq(schema.picks.id, id)).returning();
  return pick;
}

export async function deletePick(id: number) {
  const db = getDb();
  await db.delete(schema.picks).where(eq(schema.picks.id, id));
}

// ─── Results ──────────────────────────────────────────────────────────────────
export async function getResults(limit = 200) {
  const db = getDb();
  return db.select().from(schema.results).orderBy(desc(schema.results.createdAt)).limit(limit);
}

export async function createResult(data: typeof schema.results.$inferInsert) {
  const db = getDb();
  const [result] = await db.insert(schema.results).values(data).returning();
  return result;
}

export async function resultExistsForMatch(homeTeam: string, awayTeam: string, date: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ id: schema.results.id })
    .from(schema.results)
    .where(and(
      eq(schema.results.homeTeam, homeTeam),
      eq(schema.results.awayTeam, awayTeam),
      eq(schema.results.date, date)
    ))
    .limit(1);
  return rows.length > 0;
}

export async function updateResult(id: number, data: Partial<typeof schema.results.$inferInsert>) {
  const db = getDb();
  const [result] = await db.update(schema.results).set(data).where(eq(schema.results.id, id)).returning();
  return result;
}

export async function getWinLossSummary() {
  const db = getDb();
  const rows = await db.select({
    result: schema.results.result,
    count: sql<number>`count(*)::int`,
  }).from(schema.results).groupBy(schema.results.result);

  const summary = { wins: 0, losses: 0, voids: 0, total: 0, winRate: 0 };
  for (const row of rows) {
    // Accept both uppercase (WIN/LOSS) and lowercase (won/lost) for backwards compatibility
    if (row.result === 'WIN' || row.result === 'won') summary.wins += row.count;
    else if (row.result === 'LOSS' || row.result === 'lost') summary.losses += row.count;
    else if (row.result === 'VOID' || row.result === 'void') summary.voids += row.count;
  }
  summary.total = summary.wins + summary.losses;
  summary.winRate = summary.total > 0 ? Math.round((summary.wins / summary.total) * 1000) / 10 : 0;
  return summary;
}

// ─── Run Logs ─────────────────────────────────────────────────────────────────
export async function getRunLogs(limit = 30) {
  const db = getDb();
  return db.select().from(schema.runLogs).orderBy(desc(schema.runLogs.createdAt)).limit(limit);
}

export async function createRunLog(data: typeof schema.runLogs.$inferInsert) {
  const db = getDb();
  const [log] = await db.insert(schema.runLogs).values(data).returning();
  return log;
}

export async function updateRunLog(id: number, data: Partial<typeof schema.runLogs.$inferInsert>) {
  const db = getDb();
  const [log] = await db.update(schema.runLogs).set(data).where(eq(schema.runLogs.id, id)).returning();
  return log;
}

// ─── Members ──────────────────────────────────────────────────────────────────
export async function getMembers() {
  const db = getDb();
  return db.select().from(schema.members).orderBy(desc(schema.members.createdAt));
}

export async function getMemberByEmail(email: string) {
  const db = getDb();
  const [member] = await db.select().from(schema.members).where(eq(schema.members.email, email));
  return member;
}

export async function createOrUpdateMember(email: string, tier: string) {
  const db = getDb();
  const existing = await getMemberByEmail(email);
  if (existing) {
    const [m] = await db.update(schema.members).set({ tier, lastActive: new Date() }).where(eq(schema.members.email, email)).returning();
    return m;
  }
  const [m] = await db.insert(schema.members).values({ email, tier, lastActive: new Date() }).returning();
  return m;
}

export async function recordHeartbeat(email: string, page?: string) {
  const db = getDb();
  await db.insert(schema.memberHeartbeats).values({ email, page });
  await db.update(schema.members).set({ lastActive: new Date() }).where(eq(schema.members.email, email));
}

export async function getActiveUsers(minutesAgo = 15) {
  const db = getDb();
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  return db.select().from(schema.memberHeartbeats).where(gte(schema.memberHeartbeats.timestamp, since)).orderBy(desc(schema.memberHeartbeats.timestamp));
}

// ─── Parlays ──────────────────────────────────────────────────────────────────
export async function getParlaysByDate(date: string) {
  const db = getDb();
  return db.select().from(schema.parlays).where(eq(schema.parlays.date, date));
}

export async function saveParlays(date: string, type: string, legs: any[], totalOdds?: string) {
  const db = getDb();
  // Delete existing for this date/type
  await db.delete(schema.parlays).where(and(eq(schema.parlays.date, date), eq(schema.parlays.type, type)));
  const [parlay] = await db.insert(schema.parlays).values({ date, type, legs, totalOdds }).returning();
  return parlay;
}

// ─── System Alerts ────────────────────────────────────────────────────────────
export async function getAlerts(limit = 50) {
  const db = getDb();
  return db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.resolved, false)).orderBy(desc(schema.systemAlerts.createdAt)).limit(limit);
}

export async function createAlert(level: string, message: string) {
  const db = getDb();
  const [alert] = await db.insert(schema.systemAlerts).values({ level, message }).returning();
  return alert;
}

export async function resolveAlert(id: number) {
  const db = getDb();
  await db.update(schema.systemAlerts).set({ resolved: true }).where(eq(schema.systemAlerts.id, id));
}

// ─── Engine Config ────────────────────────────────────────────────────────────
export async function getEngineConfig() {
  const db = getDb();
  const rows = await db.select().from(schema.engineConfig);
  const config: Record<string, string> = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

export async function setEngineConfig(key: string, value: string) {
  const db = getDb();
  await db.insert(schema.engineConfig).values({ key, value }).onConflictDoUpdate({
    target: schema.engineConfig.key,
    set: { value, updatedAt: new Date() },
  });
}

// ─── Audit Reports ────────────────────────────────────────────────────────────
export async function getAuditReports(limit = 10) {
  const db = getDb();
  return db.select().from(schema.auditReports).orderBy(desc(schema.auditReports.createdAt)).limit(limit);
}

export async function createAuditReport(data: typeof schema.auditReports.$inferInsert) {
  const db = getDb();
  const [report] = await db.insert(schema.auditReports).values(data).returning();
  return report;
}

// ─── Player Stats ─────────────────────────────────────────────────────────────
export async function getPlayerStats(date: string, sport?: string) {
  const db = getDb();
  if (sport) {
    return db.select().from(schema.playerStats).where(and(eq(schema.playerStats.date, date), eq(schema.playerStats.sport, sport)));
  }
  return db.select().from(schema.playerStats).where(eq(schema.playerStats.date, date));
}

export async function savePlayerStat(data: typeof schema.playerStats.$inferInsert) {
  const db = getDb();
  const [stat] = await db.insert(schema.playerStats).values(data).returning();
  return stat;
}

// ─── Tier Pricing ─────────────────────────────────────────────────────────────
export async function getTierPricing() {
  const db = getDb();
  return db.select().from(schema.tierPricing);
}

export async function setTierPricing(tier: string, price: number, label?: string) {
  const db = getDb();
  await db.insert(schema.tierPricing).values({ tier, price, label }).onConflictDoUpdate({
    target: schema.tierPricing.tier,
    set: { price, label, updatedAt: new Date() },
  });
}

// ─── DB Health Check ──────────────────────────────────────────────────────────
export async function checkDbConnection(): Promise<boolean> {
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// ─── Initialize Tables ────────────────────────────────────────────────────────
export async function initializeDatabase() {
  try {
    const db = getDb();
    // Test connection
    await db.execute(sql`SELECT 1`);
    console.log('[DB] Connected to NeonDB PostgreSQL');

    // Seed default tier pricing if empty
    const pricing = await getTierPricing();
    if (pricing.length === 0) {
      await setTierPricing('free', 0, 'Free Tier');
      await setTierPricing('vip', 29.99, 'VIP Tier');
      await setTierPricing('pro', 49.99, 'Pro Tier');
    }

    // Seed default engine config
    const config = await getEngineConfig();
    if (Object.keys(config).length === 0) {
      const defaults: Record<string, string> = {
        'weight.marketConsensus': '0.25',
        'weight.momentum': '0.15',
        'weight.quality': '0.15',
        'weight.secretSauce': '0.15',
        'weight.marketSteam': '0.12',
        'weight.travelStress': '0.05',
        'weight.refereeBias': '0.05',
        'weight.environmental': '0.04',
        'weight.psychological': '0.04',
        'threshold.european': '68',
        'threshold.mls': '68',
        'threshold.nba': '68',
        'threshold.powerPick': '69',
        'threshold.free': '60',
      };
      for (const [key, value] of Object.entries(defaults)) {
        await setEngineConfig(key, value);
      }
    }

    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err);
    return false;
  }
}
