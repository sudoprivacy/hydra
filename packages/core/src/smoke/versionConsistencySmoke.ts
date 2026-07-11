/**
 * Fail-closed guard against release-version divergence across the monorepo.
 *
 * The root package.json is the single source of truth for the version. This
 * smoke discovers every root npm workspace and asserts that all manifests and
 * lockfile workspace entries carry an identical version, so a release can never
 * tag one version while shipping another package set. If it fails, run
 * `npm run sync-version`.
 *
 * Run: node packages/core/out/smoke/versionConsistencySmoke.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { discoverWorkspaceManifestPaths } from '../../../../scripts/workspace-manifests';

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

function assertWorkspaceDiscovery(): void {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-workspace-discovery-'));
  try {
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      workspaces: ['packages/*', 'tools/**', '!tools/ignored'],
    }));
    for (const relativeDirectory of ['packages/core', 'packages/protocol', 'tools/nested/sidecar', 'tools/ignored']) {
      fs.mkdirSync(path.join(fixtureRoot, relativeDirectory), { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, relativeDirectory, 'package.json'), '{}');
    }
    assert.deepEqual(discoverWorkspaceManifestPaths(fixtureRoot), [
      'packages/core/package.json',
      'packages/protocol/package.json',
      'tools/nested/sidecar/package.json',
    ]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const repoRoot = findWorkspaceRoot(__dirname);
  assertWorkspaceDiscovery();
  const workspaceManifests = discoverWorkspaceManifestPaths(repoRoot);
  const manifests = ['package.json', ...workspaceManifests];

  const rootVersion = readVersion(path.join(repoRoot, manifests[0]));
  for (const rel of manifests) {
    const version = readVersion(path.join(repoRoot, rel));
    assert.equal(
      version,
      rootVersion,
      `version mismatch: ${rel} is ${version}, expected ${rootVersion} (root package.json). Run: npm run sync-version`,
    );
  }

  const lockPath = path.join(repoRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  assert.equal(lock.version, rootVersion, 'package-lock.json root version is out of sync. Run: npm run sync-version');
  assert.equal(lock.packages?.['']?.version, rootVersion, 'package-lock.json root package is out of sync. Run: npm run sync-version');
  for (const rel of workspaceManifests) {
    const workspaceDirectory = path.dirname(rel);
    assert.equal(
      lock.packages?.[workspaceDirectory]?.version,
      rootVersion,
      `package-lock.json entry ${workspaceDirectory} is out of sync. Run: npm run sync-version`,
    );
  }

  console.log(`versionConsistencySmoke: ok (all ${manifests.length} manifests at ${rootVersion})`);
}

main();
