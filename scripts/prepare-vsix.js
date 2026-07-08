// Prepare the hydra-code extension for `vsce package` inside the npm-workspaces
// monorepo.
//
// npm hoists the extension's production dependencies to the repo-root
// node_modules, and @hydra/core is a workspace symlink. If left that way, vsce
// resolves them at `../../node_modules/...` and ends up walking the whole repo
// into the .vsix. To get a lean, self-contained package we materialize the
// extension's full production dependency closure as real directories inside
// packages/extension/node_modules (dereferencing the @hydra/core symlink into a
// built copy). vsce (invoked with --no-dependencies) then packs everything from
// within the extension folder.
//
// This mutates packages/extension/node_modules; a subsequent `npm install`
// restores the normal workspace symlink/hoist layout for development. The script
// is idempotent: it always vendors from the canonical source (repo-root
// node_modules, or packages/core for @hydra/core), never from an already-vendored
// local copy.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extDir = path.join(repoRoot, 'packages', 'extension');
const extNodeModules = path.join(extDir, 'node_modules');
const rootNodeModules = path.join(repoRoot, 'node_modules');
const coreDir = path.join(repoRoot, 'packages', 'core');

const NM = `${path.sep}node_modules${path.sep}`;

function pkgNameFromPath(p) {
  const idx = p.lastIndexOf(NM);
  return idx === -1 ? null : p.slice(idx + NM.length);
}

function vendorGeneric(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) {
    return; // already vendored in place
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // dereference: follow symlinks and copy real files (workspace/hoisted links).
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function vendorCore(dest) {
  // Ship only the built engine: package.json + out/ (excluding smoke tests).
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(coreDir, 'package.json'), path.join(dest, 'package.json'));
  fs.cpSync(path.join(coreDir, 'out'), path.join(dest, 'out'), {
    recursive: true,
    filter: (s) => !s.includes(`${path.sep}out${path.sep}smoke`),
  });
}

const parseable = execSync('npm ls -w hydra-code --omit=dev --all --parseable', {
  cwd: repoRoot,
  encoding: 'utf8',
});

// Unique dependency names in the extension's production closure.
const names = new Set();
for (const line of parseable.split('\n')) {
  const p = line.trim();
  if (!p || p === repoRoot) {
    continue;
  }
  const name = pkgNameFromPath(p);
  if (name && name !== 'hydra-code') {
    names.add(name);
  }
}

let vendored = 0;
for (const name of names) {
  const dest = path.join(extNodeModules, name);
  if (name === '@hydra/core') {
    vendorCore(dest);
  } else {
    // Always copy from the canonical (hoisted) source so re-runs are safe.
    vendorGeneric(path.join(rootNodeModules, name), dest);
  }
  vendored += 1;
  console.log('vendored', name);
}

console.log(`prepare-vsix: vendored ${vendored} production dependencies into packages/extension/node_modules`);
