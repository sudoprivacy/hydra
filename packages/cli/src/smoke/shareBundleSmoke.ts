import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkerInfo } from '../core/sessionManager';
import { createShareBundle, readBundle, writeBundle } from '../share/bundle';
import { importCodexNativeSession } from '../share/codexAdapter';
import { buildDefaultPublicBaseUrl, buildPublicHttpBundleUrl, downloadHttpBundle } from '../share/gcpStorage';
import { collectRepoInfo, validateRepoMatch } from '../share/repo';

const SESSION_ID = '019deccc-251c-7192-bf0d-e8ff36a0bb5e';

function withHome<T>(home: string, fn: () => T): T {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

async function withHomeAsync<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function createRepo(parent: string): string {
  const repoRoot = path.join(parent, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  runGit(repoRoot, ['init', '-b', 'main']);
  runGit(repoRoot, ['config', 'user.email', 'hydra@example.com']);
  runGit(repoRoot, ['config', 'user.name', 'Hydra Smoke']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# smoke\n', 'utf-8');
  runGit(repoRoot, ['add', 'README.md']);
  runGit(repoRoot, ['commit', '-m', 'initial']);
  runGit(repoRoot, ['remote', 'add', 'origin', 'git@github.com:example/repo.git']);
  return repoRoot;
}

function writeCodexSession(home: string, contents = '{"type":"session"}\n'): string {
  const sessionFile = path.join(
    home,
    '.codex',
    'sessions',
    '2026',
    '05',
    '03',
    `rollout-2026-05-03T00-44-55-${SESSION_ID}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, contents, 'utf-8');
  return sessionFile;
}

function buildWorker(repoRoot: string): WorkerInfo {
  return {
    sessionName: 'repo-feat-share',
    displayName: 'feat-share',
    workerId: 7,
    repo: 'repo',
    repoRoot,
    branch: 'main',
    slug: 'feat-share',
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir: repoRoot,
    tmuxSession: 'repo-feat-share',
    createdAt: '2026-05-12T00:00:00.000Z',
    lastSeenAt: '2026-05-12T00:00:00.000Z',
    sessionId: SESSION_ID,
    copilotSessionName: null,
  };
}

async function withBundleServer<T>(bundlePath: string, fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    if (request.url !== '/bundle.json') {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    fs.createReadStream(bundlePath).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('HTTP smoke server did not expose a TCP address');
    }
    return await fn(`http://127.0.0.1:${address.port}/bundle.json`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error); else resolve();
      });
    });
  }
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-share-smoke-'));
  const sourceHome = path.join(tempDir, 'source-home');
  const targetHome = path.join(tempDir, 'target-home');
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.mkdirSync(targetHome, { recursive: true });

  try {
    const repoRoot = createRepo(tempDir);
    const workerWorktree = path.join(tempDir, 'worker-worktree');
    runGit(repoRoot, ['branch', 'worker-branch']);
    runGit(repoRoot, ['worktree', 'add', workerWorktree, 'worker-branch']);

    const worktreeRepoInfo = await collectRepoInfo(workerWorktree);
    assert.equal(worktreeRepoInfo.repoName, 'repo');
    assert.equal(worktreeRepoInfo.branch, 'worker-branch');

    await validateRepoMatch({
      ...worktreeRepoInfo,
      repoName: 'worker-worktree',
    }, repoRoot);

    const sourceSessionFile = writeCodexSession(sourceHome);

    const bundle = await withHomeAsync(sourceHome, () => createShareBundle({
      type: 'worker',
      data: buildWorker(repoRoot),
    }, 'share-smoke'));

    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.shareId, 'share-smoke');
    assert.equal(bundle.encryption.enabled, false);
    assert.equal(bundle.hydraSession.type, 'worker');
    assert.equal(bundle.hydraSession.agentSessionId, SESSION_ID);
    assert.equal(bundle.agents.codex.files.length, 1);
    assert.equal(bundle.agents.codex.files[0]?.homeRelativePath, path.relative(sourceHome, sourceSessionFile));
    assert.equal(bundle.repo.repoName, 'repo');
    assert.equal(bundle.repo.branch, 'main');
    assert.equal(bundle.repo.remotes.origin, 'git@github.com:example/repo.git');

    const bundlePath = path.join(tempDir, 'bundle.json');
    writeBundle(bundlePath, bundle);
    assert.equal(readBundle(bundlePath).shareId, 'share-smoke');
    assert.equal(
      buildDefaultPublicBaseUrl('gs://hydra-share-smoke'),
      'https://storage.googleapis.com/hydra-share-smoke',
    );
    assert.equal(
      buildPublicHttpBundleUrl({
        publicBaseUrl: 'https://storage.googleapis.com/hydra-share-smoke/',
        prefix: '/shares/',
        shareId: 'share-smoke',
      }),
      'https://storage.googleapis.com/hydra-share-smoke/shares/share-smoke/bundle.json',
    );

    const httpDownloadedBundlePath = path.join(tempDir, 'downloaded-bundle.json');
    await withBundleServer(bundlePath, async (url) => {
      await downloadHttpBundle(url, httpDownloadedBundlePath);
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(httpDownloadedBundlePath, 'utf-8')),
      JSON.parse(fs.readFileSync(bundlePath, 'utf-8')),
    );

    const firstImport = withHome(targetHome, () => importCodexNativeSession(bundle.agents.codex));
    assert.equal(firstImport.written.length, 1);
    assert.equal(firstImport.skipped.length, 0);
    assert.equal(fs.readFileSync(firstImport.written[0]!, 'utf-8'), fs.readFileSync(sourceSessionFile, 'utf-8'));

    const secondImport = withHome(targetHome, () => importCodexNativeSession(bundle.agents.codex));
    assert.equal(secondImport.written.length, 0);
    assert.equal(secondImport.skipped.length, 1);

    fs.writeFileSync(firstImport.written[0]!, 'conflict\n', 'utf-8');
    assert.throws(
      () => withHome(targetHome, () => importCodexNativeSession(bundle.agents.codex)),
      /already exists with different contents/,
    );

    const forcedImport = withHome(targetHome, () => importCodexNativeSession(bundle.agents.codex, { force: true }));
    assert.equal(forcedImport.written.length, 1);
    assert.equal(fs.readFileSync(forcedImport.written[0]!, 'utf-8'), fs.readFileSync(sourceSessionFile, 'utf-8'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('shareBundleSmoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
