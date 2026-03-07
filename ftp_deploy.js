const ftp = require('basic-ftp');

// Hardcoded credentials (from .env)
const FTP_HOST = 'server185.web-hosting.com';
const FTP_USER = 'soccsbur';
const FTP_PASS = 'EVQEsUXk7NHt';
const FTP_PORT = 21;

const SRC_DIR = '/home/ubuntu/parlay-king-cpanel';

async function deploy() {
  const client = new ftp.Client(180000);
  client.ftp.verbose = true;

  try {
    console.log('Connecting to FTP server...');
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: FTP_PORT,
      secure: false,
    });

    console.log('Connected! Listing root...');
    const rootFiles = await client.list();
    console.log('Root dirs:', rootFiles.map(f => f.name).join(', '));

    // Navigate to public_html
    await client.cd('public_html');
    console.log('In public_html. Creating parlay-king directory...');

    // Create parlay-king directory
    try { await client.send('MKD parlay-king'); } catch(e) { console.log('Dir may already exist:', e.message); }
    await client.cd('parlay-king');

    console.log('Uploading all files from', SRC_DIR, '...');
    await client.uploadFromDir(SRC_DIR);

    console.log('\n=== Upload Complete! ===');
    const uploaded = await client.list();
    console.log('Files in /public_html/parlay-king:');
    uploaded.forEach(f => console.log(' -', f.name, f.type === 2 ? '(dir)' : `(${f.size} bytes)`));

  } catch (err) {
    console.error('FTP Error:', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

deploy();
