const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

async function deploy() {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: 'server185.web-hosting.com',
      user: 'soccsbur',
      password: 'EVQEsUXk7NHt',
      port: 21,
      secure: false
    });

    console.log('Connected to Namecheap FTP');

    // Navigate to the parlay-king directory
    await client.ensureDir('/public_html/parlay-king');
    console.log('In /public_html/parlay-king');

    // Upload the key updated files
    const filesToUpload = [
      { local: '/home/ubuntu/parlay-king/app.js', remote: 'app.js' },
      { local: '/home/ubuntu/parlay-king/server/templates/admin.html', remote: 'server/templates/admin.html' },
      { local: '/home/ubuntu/parlay-king/server/scheduler.ts', remote: 'server/scheduler.ts' },
    ];

    for (const f of filesToUpload) {
      console.log(`Uploading ${f.remote}...`);
      await client.ensureDir(path.dirname('/public_html/parlay-king/' + f.remote));
      await client.uploadFrom(f.local, '/public_html/parlay-king/' + f.remote);
      console.log(`  ✓ ${f.remote} uploaded`);
    }

    console.log('\nAll files updated on Namecheap server!');
  } catch (err) {
    console.error('FTP Error:', err.message);
  } finally {
    client.close();
  }
}

deploy();
