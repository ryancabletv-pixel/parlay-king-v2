const ftp = require('basic-ftp');
const fs = require('fs');
const path = require('path');

async function uploadEnv() {
  const client = new ftp.Client(60000);
  client.ftp.verbose = false;

  // Write .env content to a temp file
  const envContent = `NODE_ENV=production
TZ=America/Halifax
SESSION_SECRET=Zk5fL/zhGg4eDOn4XZbAZkdeMhIUO7Au9SnsKAeTLjd1Tvo2hqrKAS5E1j0mKHB5r3YhZZNPiNUnW8ofIDnj8Q==
DATABASE_URL=postgresql://neondb_owner:npg_WPim3gY4lKTj@ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require
PGHOST=ep-flat-glitter-ajh6x5nr.c-3.us-east-2.aws.neon.tech
PGPORT=5432
PGDATABASE=neondb
PGUSER=neondb_owner
PGPASSWORD=npg_WPim3gY4lKTj
API_FOOTBALL_KEY=71614ef3fd222860db4bc46a4edc3591
ODDS_API_KEY=e780bee8f11d6859d3d5a99ca8549fff
SFTP_HOST=server185.web-hosting.com
SFTP_USERNAME=soccsbur
SFTP_PASSWORD=EVQEsUXk7NHt
SFTP_PORT=21
`;

  const tmpEnvPath = '/tmp/.env_upload';
  fs.writeFileSync(tmpEnvPath, envContent);

  try {
    console.log('Connecting to FTP...');
    await client.access({
      host: 'server185.web-hosting.com',
      user: 'soccsbur',
      password: 'EVQEsUXk7NHt',
      port: 21,
      secure: false,
    });

    await client.cd('public_html/parlay-king');
    console.log('Uploading .env file...');
    await client.uploadFrom(tmpEnvPath, '.env');
    console.log('.env uploaded successfully!');

    // Also verify the file listing
    const files = await client.list();
    const envFile = files.find(f => f.name === '.env');
    if (envFile) {
      console.log(`.env confirmed on server: ${envFile.size} bytes`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.close();
    fs.unlinkSync(tmpEnvPath);
  }
}

uploadEnv();
