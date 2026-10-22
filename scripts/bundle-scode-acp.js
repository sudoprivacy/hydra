const path = require('node:path');
const { buildSync } = require('esbuild');

// Hydra is CommonJS, while the official ACP SDK is ESM. Publish one bundled
// connection implementation that both CommonJS hosts and ESM bridges can use.
buildSync({
  entryPoints: [path.join(__dirname, '../packages/core/src/core/scodeAcp.ts')],
  outfile: path.join(__dirname, '../packages/core/out/core/scodeAcp.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
});
