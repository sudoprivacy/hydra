/**
 * Fail-closed client/sidecar compatibility guard.
 *
 * This intentionally adds no protocol fields or runtime negotiation. It checks
 * that the packages shipped together have one version and that every protocol
 * operation/topic is wired by both the client and the sidecar dispatcher.
 *
 * Run: node packages/sidecar/out/smoke/protocolCompatibilitySmoke.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Op, Topic } from '@hydra/protocol';

function findWorkspaceRoot(start: string): string {
  let directory = start;
  for (;;) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { workspaces?: unknown };
      if (manifest.workspaces) {
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error('protocolCompatibilitySmoke: could not locate the workspace root');
    }
    directory = parent;
  }
}

function readPackageVersion(repoRoot: string, packageDirectory: string): string {
  const manifestPath = path.join(repoRoot, 'packages', packageDirectory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { version?: unknown };
  assert.equal(typeof manifest.version, 'string', `${manifestPath} has no string version`);
  return manifest.version as string;
}

function references(source: string, symbol: 'Op' | 'Topic', prefix = ''): Set<string> {
  return new Set(Array.from(source.matchAll(new RegExp(`${prefix}${symbol}\\.([A-Za-z0-9_]+)`, 'g')), match => match[1]));
}

function assertSameMembers(label: string, actual: Set<string>, expected: Set<string>): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} is incompatible with @hydra/protocol`);
}

function main(): void {
  const repoRoot = findWorkspaceRoot(__dirname);
  const packageVersions = new Map(
    ['protocol', 'transport-loopback', 'sidecar', 'desktop'].map(packageDirectory => [
      packageDirectory,
      readPackageVersion(repoRoot, packageDirectory),
    ]),
  );
  const expectedVersion = packageVersions.get('protocol');
  for (const [packageDirectory, version] of packageVersions) {
    assert.equal(version, expectedVersion, `mismatched client/sidecar package set: ${packageDirectory} is ${version}, expected ${expectedVersion}`);
  }

  const clientSource = fs.readFileSync(path.join(repoRoot, 'packages/protocol/src/client.ts'), 'utf-8');
  const sidecarSource = fs.readFileSync(path.join(repoRoot, 'packages/sidecar/src/appService.ts'), 'utf-8');
  assertSameMembers('HydraControlClient operations', references(clientSource, 'Op'), new Set(Object.keys(Op)));
  assertSameMembers('HydraAppService operations', references(sidecarSource, 'Op', 'case\\s+'), new Set(Object.keys(Op)));
  assertSameMembers('HydraControlClient topics', references(clientSource, 'Topic'), new Set(Object.keys(Topic)));
  assertSameMembers('HydraAppService topics', references(sidecarSource, 'Topic', 'case\\s+'), new Set(Object.keys(Topic)));

  console.log(`protocolCompatibilitySmoke: ok (${expectedVersion}, ${Object.keys(Op).length} ops, ${Object.keys(Topic).length} topics)`);
}

main();
