const path = require('node:path');
const { buildSync } = require('esbuild');

// The CLI is also copied into Desktop/VSIX runtimes. Bundle its optional MCP
// dependencies instead of relying on the development workspace's npm hoisting.
buildSync({
  entryPoints: [path.join(__dirname, '../packages/cli/src/cli/commands/scodeMcp.ts')],
  outfile: path.join(__dirname, '../packages/cli/out/cli/commands/scodeMcp.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  // Keep the single connection implementation and CLI shutdown owner shared.
  external: ['@hydra/core/*', '../commandLifetime'],
});
