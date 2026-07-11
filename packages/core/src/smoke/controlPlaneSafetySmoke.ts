import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DiffService,
  MAX_FILE_SNAPSHOT_BYTES,
  readBoundedSnapshotBytes,
  type BoundedSnapshotReader,
} from '../core/diff';
import { SessionManager, type WorkerInfo } from '../core/sessionManager';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';

class OwnershipBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'ownership-smoke';
  readonly installHint = 'none';
  readonly sessions = new Set<string>();
  readonly workdirs = new Map<string, string>();
  readonly roles = new Map<string, HydraRole>();
  readonly workerIds = new Map<string, number>();
  readonly workerIdErrors = new Map<string, Error>();
  readonly workerIdWrites: Array<{ sessionName: string; workerId: number }> = [];
  readonly killed: string[] = [];
  onWorkerIdWrite?: (sessionName: string, workerId: number, writeIndex: number) => void;

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> { return []; }
  async createSession(sessionName: string, workdir: string): Promise<void> { this.sessions.add(sessionName); this.workdirs.set(sessionName, workdir); }
  async killSession(sessionName: string): Promise<void> { this.killed.push(sessionName); this.sessions.delete(sessionName); }
  async renameSession(): Promise<void> {}
  async hasSession(sessionName: string): Promise<boolean> { return this.sessions.has(sessionName); }
  async getSessionWorkdir(sessionName: string): Promise<string | undefined> { return this.workdirs.get(sessionName); }
  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> { this.workdirs.set(sessionName, workdir); }
  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> { return this.roles.get(sessionName); }
  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> { this.roles.set(sessionName, role); }
  async getSessionWorkerId(sessionName: string): Promise<number | undefined> {
    const error = this.workerIdErrors.get(sessionName);
    if (error) throw error;
    return this.workerIds.get(sessionName);
  }
  async setSessionWorkerId(sessionName: string, workerId: number): Promise<void> {
    this.workerIds.set(sessionName, workerId);
    this.workerIdWrites.push({ sessionName, workerId });
    this.onWorkerIdWrite?.(sessionName, workerId, this.workerIdWrites.length);
  }
  async getSessionAgent(): Promise<string | undefined> { return undefined; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> { return 'Session: 11111111-1111-4111-8111-111111111111\n⏵'; }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

function worker(sessionName: string, workdir: string): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'directory', sessionName, displayName: sessionName, workerId: 7,
    repo: null, repoRoot: null, branch: null, slug: sessionName, status: 'running',
    attached: false, agent: 'codex', workdir, managedWorkdir: false,
    tmuxSession: sessionName, createdAt: now, lastSeenAt: now, sessionId: null,
    copilotSessionName: null,
  };
}

async function expectReject(label: string, action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, pattern, label);
}

class ChunkReader implements BoundedSnapshotReader {
  private offset = 0;

  constructor(
    private readonly content: Buffer,
    private readonly chunkSize: number,
  ) {}

  async read(buffer: Buffer, offset: number, length: number): Promise<{ bytesRead: number }> {
    const bytesRead = Math.min(length, this.chunkSize, this.content.length - this.offset);
    if (bytesRead <= 0) return { bytesRead: 0 };
    this.content.copy(buffer, offset, this.offset, this.offset + bytesRead);
    this.offset += bytesRead;
    return { bytesRead };
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-control-plane-safety-'));
  const previousHome = process.env.HYDRA_HOME;
  const previousConfig = process.env.HYDRA_CONFIG_PATH;
  try {
    const workdir = path.join(root, 'workdir');
    const hydraHome = path.join(root, 'hydra');
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(hydraHome, { recursive: true });
    process.env.HYDRA_HOME = hydraHome;
    delete process.env.HYDRA_CONFIG_PATH;

    const service = new DiffService();
    fs.writeFileSync(path.join(workdir, 'regular.txt'), 'safe text\n');
    assert.equal((await service.getFileSnapshot(workdir, 'regular.txt')).content, 'safe text\n');

    fs.writeFileSync(path.join(workdir, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42]));
    await expectReject('binary current snapshot', () => service.getFileSnapshot(workdir, 'binary.dat'), /Binary file snapshots/);

    fs.writeFileSync(path.join(workdir, 'large.txt'), Buffer.alloc(MAX_FILE_SNAPSHOT_BYTES + 1, 0x61));
    await expectReject('oversized current snapshot', () => service.getFileSnapshot(workdir, 'large.txt'), /exceeds/);

    const boundedContent = Buffer.alloc(MAX_FILE_SNAPSHOT_BYTES, 0x61);
    const boundedRead = await readBoundedSnapshotBytes(new ChunkReader(boundedContent, 8191), 'bounded.txt');
    assert.equal(boundedRead.length, MAX_FILE_SNAPSHOT_BYTES, 'bounded reader accepts the exact byte ceiling');
    assert.equal(boundedRead.compare(boundedContent), 0, 'bounded reader preserves partial-read content');
    await expectReject(
      'bounded reader overflow',
      () => readBoundedSnapshotBytes(
        new ChunkReader(Buffer.alloc(MAX_FILE_SNAPSHOT_BYTES + 1, 0x61), 4093),
        'grown.txt',
      ),
      /exceeds/,
    );

    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'safety@hydra.test'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Safety Smoke'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'base-binary.dat'), Buffer.from([0x41, 0x00, 0x42]));
    fs.writeFileSync(path.join(repo, 'base-large.txt'), Buffer.alloc(MAX_FILE_SNAPSHOT_BYTES + 1, 0x61));
    fs.symlinkSync('base-binary.dat', path.join(repo, 'base-link.dat'));
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
    fs.rmSync(path.join(repo, 'base-binary.dat'));
    fs.rmSync(path.join(repo, 'base-large.txt'));
    fs.rmSync(path.join(repo, 'base-link.dat'));
    await expectReject('binary base snapshot', () => service.getFileSnapshot(repo, 'base-binary.dat', 'base'), /Binary file snapshots/);
    await expectReject('oversized base snapshot', () => service.getFileSnapshot(repo, 'base-large.txt', 'base'), /exceeds/);
    await expectReject('symlink base snapshot', () => service.getFileSnapshot(repo, 'base-link.dat', 'base'), /not a regular file/);

    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    try {
      fs.symlinkSync(outside, path.join(workdir, 'escape.txt'));
      await expectReject('symlink escape', () => service.getFileSnapshot(workdir, 'escape.txt'), /escapes/);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
    }

    const raceBackend = new OwnershipBackend();
    const raceManager = new SessionManager(raceBackend);
    const raceStatePath = path.join(hydraHome, 'sessions.json');
    fs.writeFileSync(raceStatePath, JSON.stringify({
      copilots: {}, workers: {}, nextWorkerId: 1, updatedAt: new Date().toISOString(),
    }), 'utf8');
    raceBackend.onWorkerIdWrite = (_sessionName, _workerId, writeIndex) => {
      if (writeIndex !== 1) return;
      const state = JSON.parse(fs.readFileSync(raceStatePath, 'utf8')) as { nextWorkerId: number };
      state.nextWorkerId = 9;
      fs.writeFileSync(raceStatePath, JSON.stringify(state), 'utf8');
    };
    const raced = await raceManager.createDirectoryWorker({
      workdir: path.join(root, 'race-worker'),
      name: 'race-worker',
      agentType: 'codex',
      agentCommand: 'codex',
      notifyCopilot: false,
    });
    await raced.postCreatePromise;
    assert.equal(raced.workerInfo.workerId, 1, 'worker identity is reserved before backend launch');
    assert.deepEqual(
      raceBackend.workerIdWrites.map(write => write.workerId),
      [1, 1],
      'hook and tmux metadata use the same reserved worker identity',
    );

    const sessionName = 'hydra-owned';
    fs.writeFileSync(path.join(hydraHome, 'sessions.json'), JSON.stringify({
      copilots: {}, workers: { [sessionName]: worker(sessionName, workdir) }, nextWorkerId: 8,
      updatedAt: new Date().toISOString(),
    }), 'utf8');
    const backend = new OwnershipBackend();
    const manager = new SessionManager(backend);

    await assert.doesNotReject(() => manager.assertHydraSessionOwnership(sessionName, 'worker'), 'missing known session is safe');

    backend.sessions.add(sessionName);
    backend.workdirs.set(sessionName, workdir);
    backend.roles.set(sessionName, 'worker');
    await assert.doesNotReject(() => manager.assertHydraSessionOwnership(sessionName, 'worker'), 'legacy metadata remains supported');

    backend.workerIds.set(sessionName, 7);
    await manager.stopWorker(sessionName);
    assert.deepEqual(backend.killed, [sessionName], 'known Hydra session is stopped');

    backend.sessions.add('ordinary-user-tmux');
    await expectReject('unknown session stop', () => manager.stopWorker('ordinary-user-tmux'), /unknown Hydra worker/);
    await expectReject('unknown session delete', () => manager.deleteWorker('ordinary-user-tmux'), /unknown Hydra worker/);
    assert.deepEqual(backend.killed, [sessionName], 'foreign session is never killed');

    backend.sessions.add(sessionName);
    backend.workdirs.set(sessionName, path.join(root, 'foreign'));
    await expectReject('foreign metadata stop', () => manager.stopWorker(sessionName), /foreign tmux session/);
    await expectReject('foreign metadata delete', () => manager.deleteWorker(sessionName), /foreign tmux session/);
    assert.deepEqual(backend.killed, [sessionName], 'mismatched session is never killed');

    backend.workdirs.set(sessionName, workdir);
    backend.workerIds.set(sessionName, 8);
    await expectReject('wrong worker ID', () => manager.assertHydraSessionOwnership(sessionName, 'worker'), /worker identity/);

    backend.workerIds.delete(sessionName);
    backend.workerIdErrors.set(sessionName, new Error('Malformed @hydra-worker-id on tmux session "hydra-owned": nope'));
    await expectReject('malformed worker ID', () => manager.assertHydraSessionOwnership(sessionName, 'worker'), /Malformed @hydra-worker-id/);

    const coreExec = await import('../core/exec') as unknown as { exec: (...args: unknown[]) => Promise<string> };
    const originalExec = coreExec.exec;
    coreExec.exec = async () => 'nope';
    try {
      const { TmuxBackendCore } = await import('../core/tmux');
      await expectReject(
        'tmux malformed worker ID parser',
        () => new TmuxBackendCore().getSessionWorkerId(sessionName),
        /Malformed @hydra-worker-id/,
      );
    } finally {
      coreExec.exec = originalExec;
    }

    console.log('controlPlaneSafetySmoke: ok');
  } finally {
    if (previousHome === undefined) delete process.env.HYDRA_HOME;
    else process.env.HYDRA_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
