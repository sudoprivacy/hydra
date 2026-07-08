// Propagate the single source-of-truth version (root package.json) into every
// workspace manifest and the lockfile, so the tag (auto-tag-release.yml, from
// root), the packaged .vsix (from packages/extension/package.json), and the CLI/
// telemetry version reads (from packages/{core,cli}/package.json) can never
// diverge.
//
// Usage: `npm run sync-version` — run after bumping the version in the ROOT
// package.json. Enforced by smoke:version-consistency (fails the test suite if
// any manifest drifts).

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

if (!version || typeof version !== 'string') {
  console.error('sync-version: root package.json has no valid "version"');
  process.exit(1);
}

const workspaceManifests = [
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/extension/package.json',
  'packages/desktop/package.json',
];

function writeJson(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

let changed = 0;

// 1. Workspace package.json manifests.
for (const rel of workspaceManifests) {
  const p = path.join(repoRoot, rel);
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(p, pkg);
    console.log(`synced ${rel} -> ${version}`);
    changed += 1;
  }
}

// 2. package-lock.json (lockfileVersion 3 records each workspace version).
const lockPath = path.join(repoRoot, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let lockChanged = false;
  const setVersion = (node) => {
    if (node && node.version !== version) {
      node.version = version;
      lockChanged = true;
    }
  };
  if (lock.version !== version) {
    lock.version = version;
    lockChanged = true;
  }
  if (lock.packages) {
    setVersion(lock.packages['']);
    for (const rel of workspaceManifests) {
      setVersion(lock.packages[path.dirname(rel)]); // e.g. "packages/core"
    }
  }
  if (lockChanged) {
    writeJson(lockPath, lock);
    console.log(`synced package-lock.json -> ${version}`);
    changed += 1;
  }
}

console.log(`sync-version: root version ${version} propagated (${changed} file(s) updated)`);
