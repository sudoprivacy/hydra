// Bundle the React renderer to out/renderer.js with esbuild. The Node/Electron
// side (main, preload, launcher, bootCheck) is built by `tsc -b tsconfig.json`;
// this handles only the browser bundle. (Vite could replace this later; esbuild
// keeps the scaffold tiny and dependency-light.)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ship a PRODUCTION React bundle by default. Dev mode + <StrictMode> double-
// invokes effects, which races xterm's async render against the terminal
// effect's cleanup-dispose and throws an uncaught "reading 'dimensions'".
// Set NODE_ENV=development explicitly for a dev build.
const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';

await build({
  entryPoints: [path.join(packageDir, 'src', 'renderer', 'index.tsx')],
  outfile: path.join(packageDir, 'out', 'renderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: 'linked',
  // React reads process.env.NODE_ENV; provide it for the browser bundle.
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  minify: mode === 'production',
  logLevel: 'info',
});

console.log('hydra-desktop: renderer bundled → out/renderer.js');
