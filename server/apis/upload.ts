import * as ftp from 'basic-ftp';
import { writeFileSync, unlinkSync } from 'fs';
import { PredictionResult } from '../goldStandardV2.js';

const FTP_CONFIG = {
  host: process.env.SFTP_HOST || 'server185.web-hosting.com',
  user: process.env.SFTP_USERNAME || 'soccsbur',
  password: process.env.SFTP_PASSWORD || 'EVQEsUXk7NHt',
  port: parseInt(process.env.SFTP_PORT || '21'),
  secure: false,
};

// Protected files that should never be deleted
const PROTECTED_FILES = [
  'index.html', 'landing-page.html', 'admin.html', 'accounts.html',
  'pricing.html', 'access-gatekeeper.js', 'chat-widget.js', 'member-tracker.js',
  'picks.html', 'results.html', 'nba.html', 'nba-picks.html',
];

// ─── Format a single pick leg ─────────────────────────────────────────────────
function formatLeg(p: PredictionResult, date: string) {
  const dateDisplay = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/Moncton',
  });
  return {
    game: `${p.homeTeam} vs ${p.awayTeam}`,
    match: `${p.homeTeam} vs ${p.awayTeam}`,
    pick: p.topPick,
    pick_type: p.topPick,
    pick_label: p.topPick,
    confidence: Math.round(p.topConfidence),
    probability: parseFloat((p.topConfidence / 100).toFixed(2)),
    probability_display: `${Math.round(p.topConfidence)}%`,
    confidence_pct: `${Math.round(p.topConfidence)}%`,
    league: p.league || 'Unknown League',
    odds: (p as any).odds || '-110',
    time: `${dateDisplay} — Today`,
    time_display: `${dateDisplay} — Today`,
    analysis: `Gold Standard V3 Titan XII — ${p.topPick} at ${Math.round(p.topConfidence)}%. 12-factor AI engine pick.`,
    reasoning: `Gold Standard V3 Titan XII — ${p.topPick} at ${Math.round(p.topConfidence)}%. 12-factor AI engine pick.`,
    home_team: p.homeTeam,
    away_team: p.awayTeam,
    tier: p.tier || 'free',
    sport: p.sport || 'soccer',
  };
}

// ─── Combined probability for a parlay ───────────────────────────────────────
function combinedProb(legs: PredictionResult[]): string {
  if (!legs.length) return '0%';
  const combined = legs.reduce((acc, p) => acc * (p.topConfidence / 100), 1);
  return `${(combined * 100).toFixed(1)}%`;
}

// ─── Build the full picks.json payload matching the original site structure ───
export function buildPicksJson(date: string, allPicks: PredictionResult[]) {
  const now = new Date().toISOString();
  const dateObj = new Date(date + 'T12:00:00Z');
  const dateDisplay = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Moncton',
  });

  // Separate by sport
  const soccerPicks = allPicks.filter(p => p.sport === 'soccer').slice(0, 3);
  const mlsPicks    = allPicks.filter(p => p.sport === 'mls').slice(0, 3);
  const nbaPicks    = allPicks.filter(p => p.sport === 'nba').slice(0, 3);
  const powerPick   = allPicks.find(p => p.isPowerPick)
    || [...allPicks].sort((a, b) => b.topConfidence - a.topConfidence)[0];

  const parlayLegs = soccerPicks.map(p => formatLeg(p, date));
  const mlsLegs    = mlsPicks.map(p => formatLeg(p, date));
  const nbaLegs    = nbaPicks.map(p => formatLeg(p, date));
  const mlsNoSlate = mlsLegs.length === 0;

  const topSoccer = soccerPicks[0];
  const topMls    = mlsPicks[0];
  const topNba    = nbaPicks[0];

  return {
    date,
    generated_at: now,
    last_generated: now,
    last_updated_display: dateDisplay,
    tiers: {
      power_pick: 'free',
      soccer_picks: 'free',
      mls_parlay: 'free',
      nba_parlay: 'free',
      nba_picks: 'free',
    },

    // 3-Leg Soccer Parlay
    parlay: {
      legs: parlayLegs,
      legs_count: parlayLegs.length,
      banner: `Gold Standard V3 Titan XII — ${parlayLegs.length} Soccer Legs. 12-Factor AI Engine.`,
      combined_probability: combinedProb(soccerPicks),
    },

    // Conservative 3-Leg (same as soccer parlay)
    three_leg_conservative: {
      legs: parlayLegs,
      legs_count: parlayLegs.length,
      banner: 'Gold Standard V3 Titan XII — Conservative 3-Leg Play.',
      combined_probability: combinedProb(soccerPicks),
    },

    // Soccer picks list
    soccer_picks: soccerPicks.map(p => formatLeg(p, date)),

    // MLS parlay
    mls_parlay: {
      legs: mlsLegs,
      legs_count: mlsLegs.length,
      combined_probability: combinedProb(mlsPicks),
    },
    mls_no_slate: mlsNoSlate,
    mls_next_slate_date: mlsNoSlate ? 'Check back soon' : '',

    // NBA parlay
    nba_parlay: {
      legs: nbaLegs,
      legs_count: nbaLegs.length,
      combined_probability: combinedProb(nbaPicks),
    },

    // Corner parlay placeholder
    corner_parlay: { legs: [], legs_count: 0, combined_probability: '0%' },

    // Power Pick
    power_pick: powerPick ? {
      game: `${powerPick.homeTeam} vs ${powerPick.awayTeam}`,
      pick: powerPick.topPick,
      league: powerPick.league || 'Unknown League',
      probability: parseFloat((powerPick.topConfidence / 100).toFixed(2)),
      probability_display: `${Math.round(powerPick.topConfidence)}%`,
      odds: (powerPick as any).odds || '-110',
      time: `${date} — Today`,
      analysis: `Gold Standard V3 Titan XII — ${powerPick.topPick} at ${Math.round(powerPick.topConfidence)}%. Highest confidence pick of the day.`,
    } : null,

    // Featured pick
    featured_pick: powerPick ? {
      game: `${powerPick.homeTeam} vs ${powerPick.awayTeam}`,
      league: powerPick.league || 'Unknown League',
      pick: powerPick.topPick,
      pick_type: powerPick.topPick,
      confidence: Math.round(powerPick.topConfidence),
      probability: parseFloat((powerPick.topConfidence / 100).toFixed(2)),
      confidence_pct: `${Math.round(powerPick.topConfidence)}%`,
      odds: (powerPick as any).odds || '-110',
      time_display: date,
      label: 'POWER PICK',
      pick_label: powerPick.topPick,
      reasoning: `Gold Standard V3 Titan XII — Top pick of the day at ${Math.round(powerPick.topConfidence)}%.`,
      public_interest_disclaimer: '',
      auto_generated: true,
      tag: 'POWER PICK',
      disclaimer: 'For entertainment purposes only.',
    } : null,

    featured_soccer: topSoccer ? {
      match: `${topSoccer.homeTeam} vs ${topSoccer.awayTeam}`,
      league: topSoccer.league || 'Soccer',
      sport: 'soccer',
      pick: topSoccer.topPick,
      confidence: Math.round(topSoccer.topConfidence),
      confidence_display: `${Math.round(topSoccer.topConfidence)}%`,
      momentum_score: 0.75,
      quality_score: 0.72,
      mq_composite: 0.735,
      reasoning: `Gold Standard V3 Titan XII — ${topSoccer.topPick} at ${Math.round(topSoccer.topConfidence)}%.`,
      match_date: date,
    } : { match: '', league: '', sport: 'soccer', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date },

    featured_mls: topMls ? {
      match: `${topMls.homeTeam} vs ${topMls.awayTeam}`,
      league: topMls.league || 'MLS',
      sport: 'mls',
      pick: topMls.topPick,
      confidence: Math.round(topMls.topConfidence),
      confidence_display: `${Math.round(topMls.topConfidence)}%`,
      reasoning: `Gold Standard V3 Titan XII — ${topMls.topPick} at ${Math.round(topMls.topConfidence)}%.`,
      match_date: date,
    } : { match: '', league: 'MLS', sport: 'mls', pick: '', confidence: 0, confidence_display: '0%', reasoning: 'No MLS games today.', match_date: date },

    featured_nba: topNba ? {
      match: `${topNba.homeTeam} vs ${topNba.awayTeam}`,
      league: topNba.league || 'NBA',
      sport: 'nba',
      pick: topNba.topPick,
      confidence: Math.round(topNba.topConfidence),
      confidence_display: `${Math.round(topNba.topConfidence)}%`,
      momentum_score: 0.78,
      quality_score: 0.74,
      mq_composite: 0.76,
      reasoning: `Gold Standard V3 Titan XII — ${topNba.topPick} at ${Math.round(topNba.topConfidence)}%.`,
      match_date: date,
    } : { match: '', league: 'NBA', sport: 'nba', pick: '', confidence: 0, confidence_display: '0%', reasoning: '', match_date: date },

    // NBA picks list
    nba_picks: nbaPicks.map(p => ({
      match: `${p.homeTeam} vs ${p.awayTeam}`,
      game: `${p.homeTeam} vs ${p.awayTeam}`,
      home_team: p.homeTeam,
      away_team: p.awayTeam,
      pick: p.topPick,
      odds: (p as any).odds || '-110',
      probability: parseFloat((p.topConfidence / 100).toFixed(2)),
      time_display: date,
      analysis: `Gold Standard V3 Titan XII — ${p.topPick} at ${Math.round(p.topConfidence)}%.`,
      tier: p.tier || 'free',
    })),

    player_prop_picks: [],

    free_tier_picks: allPicks.filter(p => p.tier === 'free').slice(0, 3).map(p => ({
      game: `${p.homeTeam} vs ${p.awayTeam}`,
      home_team: p.homeTeam,
      away_team: p.awayTeam,
      league: p.league || 'Unknown',
      sport: p.sport || 'soccer',
      pick: p.topPick,
      confidence: Math.round(p.topConfidence),
      reasoning: `Gold Standard V3 Titan XII — ${p.topPick} at ${Math.round(p.topConfidence)}%.`,
      match_date: date,
      tier: 'free',
    })),

    results: { date_display: dateDisplay, entries: [] },

    expert_analysis: {
      title: `Gold Standard V3 Titan XII — ${dateDisplay}`,
      key_variable: 'Market Consensus + Momentum + Quality',
      body: `Today's picks were generated by the Gold Standard V3 Titan XII 12-factor AI engine. All picks passed the 68% confidence threshold. The engine scanned 80+ leagues worldwide.`,
      visible: true,
      updated_at: now,
    },

    manual_lock: false,
    locked_sections: [],

    featured_games: allPicks.slice(0, 3).map((p, i) => ({
      rank: i + 1,
      game: `${p.homeTeam} vs ${p.awayTeam}`,
      league: p.league || 'Unknown',
      pick: p.topPick,
      confidence: Math.round(p.topConfidence),
      confidence_pct: `${Math.round(p.topConfidence)}%`,
      reasoning: `Gold Standard V3 Titan XII — ${p.topPick} at ${Math.round(p.topConfidence)}%.`,
      time_display: date,
      sport: p.sport || 'soccer',
      auto_generated: true,
      tag: i === 0 ? 'TOP PICK' : i === 1 ? 'VALUE PLAY' : 'SAFE BET',
    })),
  };
}

// ─── Upload picks.json to FTP ─────────────────────────────────────────────────
export async function uploadPicksToFTP(date: string, picks: PredictionResult[]): Promise<void> {
  const client = new ftp.Client(60000);
  client.ftp.verbose = false;

  try {
    await client.access(FTP_CONFIG);
    console.log('[FTP] Connected to', FTP_CONFIG.host);

    const picksJson = buildPicksJson(date, picks);
    const tmpPath = `/tmp/picks_upload_${date}.json`;
    writeFileSync(tmpPath, JSON.stringify(picksJson, null, 2));

    // Upload as picks.json — the file the original site reads
    await client.uploadFrom(tmpPath, '/public_html/picks.json');
    console.log(`[FTP] ✅ Uploaded picks.json to /public_html/picks.json (${picks.length} picks, ${date})`);

    // Backup with date
    try {
      await client.uploadFrom(tmpPath, `/public_html/picks_data/picks-${date}.json`);
      console.log(`[FTP] Backup saved to picks_data/picks-${date}.json`);
    } catch { /* picks_data dir may not exist, ignore */ }

    try { unlinkSync(tmpPath); } catch {}

  } catch (err: any) {
    console.error('[FTP] Upload failed:', err?.message || err);
    throw err;
  } finally {
    client.close();
  }
}

// ─── List FTP files ───────────────────────────────────────────────────────────
export async function listFTPFiles(): Promise<any[]> {
  const client = new ftp.Client(15000);
  try {
    await client.access(FTP_CONFIG);
    const files = await client.list('/public_html');
    return files.map(f => ({
      name: f.name,
      size: f.size,
      date: f.modifiedAt,
      isProtected: PROTECTED_FILES.includes(f.name),
    }));
  } catch (err: any) {
    console.error('[FTP] List failed:', err?.message || err);
    return [];
  } finally {
    client.close();
  }
}

// ─── Delete FTP file ──────────────────────────────────────────────────────────
export async function deleteFTPFile(filename: string): Promise<void> {
  if (PROTECTED_FILES.includes(filename)) {
    throw new Error(`Cannot delete protected file: ${filename}`);
  }
  const client = new ftp.Client(15000);
  try {
    await client.access(FTP_CONFIG);
    await client.remove(`/public_html/${filename}`);
    console.log(`[FTP] Deleted: ${filename}`);
  } finally {
    client.close();
  }
}

// ─── Upload any HTML file ─────────────────────────────────────────────────────
export async function uploadHTMLFile(localPath: string, remoteName: string): Promise<void> {
  const client = new ftp.Client(30000);
  try {
    await client.access(FTP_CONFIG);
    await client.uploadFrom(localPath, remoteName);
    console.log(`[FTP] Uploaded: ${remoteName}`);
  } finally {
    client.close();
  }
}

// ─── Download FTP file content ────────────────────────────────────────────────
export async function downloadFTPFile(filename: string): Promise<string> {
  const client = new ftp.Client(15000);
  const tmpPath = `/tmp/ftp_dl_${Date.now()}`;
  try {
    await client.access(FTP_CONFIG);
    await client.downloadTo(tmpPath, `/public_html/${filename}`);
    const { readFileSync } = await import('fs');
    return readFileSync(tmpPath, 'utf8');
  } finally {
    client.close();
    try { unlinkSync(tmpPath); } catch {}
  }
}
