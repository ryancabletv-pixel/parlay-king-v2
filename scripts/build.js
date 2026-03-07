const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'app.js',
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
  console.log('Server build complete: server_dist/index.js');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
