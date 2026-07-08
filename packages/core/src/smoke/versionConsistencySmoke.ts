/**
 * Fail-closed guard against release-version divergence across the monorepo.
 *
 * The root package.json is the single source of truth for the version. This
 * smoke asserts that all five manifests (root + core + cli + extension + desktop)
 * carry an identical version, so a release can never tag one version while shipping
 * another in the .vsix / CLI / telemetry / desktop app. If it fails, run
 * `npm run sync-version`.
 *
 * Run: node packages/core/out/smoke/versionConsistencySmoke.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('versionConsistencySmoke: could not locate the workspace root');
    }
    dir = parent;
  }
}

function readVersion(p: string): string {
  const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { version?: unknown };
  assert.equal(typeof pkg.version, 'string', `${p} has no string "version"`);
  return pkg.version as string;
}

function main(): void {
  const repoRoot = findWorkspaceRoot(__dirname);
  const manifests = [
    'package.json',
    'packages/core/package.json',
    'packages/cli/package.json',
    'packages/extension/package.json',
    'packages/desktop/package.json',
  ];

  const rootVersion = readVersion(path.join(repoRoot, manifests[0]));
  for (const rel of manifests) {
    const version = readVersion(path.join(repoRoot, rel));
    assert.equal(
      version,
      rootVersion,
      `version mismatch: ${rel} is ${version}, expected ${rootVersion} (root package.json). Run: npm run sync-version`,
    );
  }

  console.log(`versionConsistencySmoke: ok (all ${manifests.length} manifests at ${rootVersion})`);
}

main();
