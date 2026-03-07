const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

esbuild.build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'server_dist/index.js',
  format: 'cjs',
  external: [
    'pg-native',
    'bufferutil',
    'utf-8-validate',
    'fsevents'
  ],
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}).then(() => {
  // Also copy to app.js for backwards compatibility
  fs.copyFileSync('server_dist/index.js', 'app.js');
  console.log('Server build complete: server_dist/index.js + app.js');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
