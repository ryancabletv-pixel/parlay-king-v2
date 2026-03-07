import * as ftp from 'basic-ftp';
import { PredictionResult } from '../goldStandardV2.js';

const FTP_CONFIG = {
  host: process.env.SFTP_HOST || 'server185.web-hosting.com',
  user: process.env.SFTP_USERNAME || 'soccsbur',
  password: process.env.SFTP_PASSWORD || '',
  port: parseInt(process.env.SFTP_PORT || '21'),
  secure: false,
};

// Protected files that should never be deleted
const PROTECTED_FILES = [
  'index.html', 'landing-page.html', 'admin.html', 'accounts.html',
  'pricing.html', 'access-gatekeeper.js', 'chat-widget.js', 'member-tracker.js',
];

export async function uploadPicksToFTP(date: string, picks: PredictionResult[]): Promise<void> {
  if (!process.env.SFTP_PASSWORD) {
    console.warn('[FTP] SFTP_PASSWORD not set, skipping upload');
    return;
  }

  const client = new ftp.Client(30000);
  client.ftp.verbose = false;

  try {
    await client.access(FTP_CONFIG);
    console.log('[FTP] Connected to', FTP_CONFIG.host);

    // Generate picks JSON
    const picksData = {
      date,
      generated: new Date().toISOString(),
      version: 'V3 Titan XII',
      picks: picks.map(p => ({
        id: p.fixtureId,
        home: p.homeTeam,
        away: p.awayTeam,
        league: p.league,
        sport: p.sport,
        prediction: p.topPick,
        confidence: p.topConfidence,
        isPowerPick: p.isPowerPick,
        tier: p.tier,
        recommendation: p.recommendation,
      })),
    };

    // Write to temp file and upload
    const { writeFileSync, unlinkSync } = await import('fs');
    const tmpPath = `/tmp/picks-${date}.json`;
    writeFileSync(tmpPath, JSON.stringify(picksData, null, 2));

    await client.uploadFrom(tmpPath, `picks-${date}.json`);
    console.log(`[FTP] Uploaded picks-${date}.json (${picks.length} picks)`);

    unlinkSync(tmpPath);
  } catch (err) {
    console.error('[FTP] Upload failed:', err);
    throw err;
  } finally {
    client.close();
  }
}

export async function listFTPFiles(): Promise<any[]> {
  if (!process.env.SFTP_PASSWORD) {
    return [{ name: 'FTP not configured', size: 0, type: 0 }];
  }

  const client = new ftp.Client(15000);
  try {
    await client.access(FTP_CONFIG);
    const files = await client.list();
    return files.map(f => ({
      name: f.name,
      size: f.size,
      date: f.modifiedAt,
      isProtected: PROTECTED_FILES.includes(f.name),
    }));
  } catch (err) {
    console.error('[FTP] List failed:', err);
    throw err;
  } finally {
    client.close();
  }
}

export async function deleteFTPFile(filename: string): Promise<void> {
  if (PROTECTED_FILES.includes(filename)) {
    throw new Error(`Cannot delete protected file: ${filename}`);
  }

  const client = new ftp.Client(15000);
  try {
    await client.access(FTP_CONFIG);
    await client.remove(filename);
    console.log(`[FTP] Deleted: ${filename}`);
  } finally {
    client.close();
  }
}

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
