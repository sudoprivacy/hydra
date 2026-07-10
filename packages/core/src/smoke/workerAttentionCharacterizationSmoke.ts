/**
 * Characterization smoke for the worker-attention re-architecture.
 *
 * This suite intentionally records known broken behavior without changing
 * production code. Each implementation PR flips only the scenario it fixes
 * from `known-failure` to `fixed`, then updates the assertion to the new
 * contract. Keeping the ledger executable prevents the multi-PR program from
 * silently changing or losing a reproduction.
 *
 * Run: node packages/core/out/smoke/workerAttentionCharacterizationSmoke.js
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiffService } from '../core/diff';
import { EventLog } from '../core/events';
import { NotificationStateService } from '../core/notificationStateService';
import { NotificationStore } from '../core/notifications';
import {
  SessionManager,
  type ArchivedSessionInfo,
  type ArchiveState,
  type WorkerInfo,
} from '../core/sessionManager';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';
import {
  classifyCodexNeedsInputTranscriptText,
  classifyCodexRuntimeTranscriptText,
} from '../core/workerNeedsInputClassifier';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';

type ScenarioId =
  | 'stale-notification-runtime-rollback'
  | 'event-only-notification-clear'
  | 'codex-turn-aborted-resolution'
  | 'completion-pending-overwrite'
  | 'diff-symlink-escape'
  | 'foreign-tmux-stop'
  | 'archive-concurrent-update';

type ExpectedState = 'known-failure' | 'fixed';

interface ScenarioResult {
  fixed: boolean;
  detail: string;
  skipped?: boolean;
}
interface TestContext {
  root: string;
  home: string;
  hydraHome: string;
  configPath: string;
}

interface ArchiveInternals {
  readArchiveState(): ArchiveState;
  writeArchiveState(state: ArchiveState): void;
}

const EXPECTATIONS: Record<ScenarioId, ExpectedState> = {
  'stale-notification-runtime-rollback': 'known-failure',
  'event-only-notification-clear': 'known-failure',
  'codex-turn-aborted-resolution': 'known-failure',
  'completion-pending-overwrite': 'known-failure',
  'diff-symlink-escape': 'fixed',
  'foreign-tmux-stop': 'fixed',
  'archive-concurrent-update': 'known-failure',
};

class RecordingBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'recording-backend';
  readonly installHint = 'not needed';
  readonly killedSessions: string[] = [];

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> { return []; }
  async createSession(): Promise<void> {}
  async killSession(sessionName: string): Promise<void> { this.killedSessions.push(sessionName); }
  async renameSession(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false; }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<HydraRole | undefined> { return undefined; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return undefined; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> { return ''; }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

function createContext(prefix: string): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  return { root, home, hydraHome, configPath };
}

async function withContext<T>(prefix: string, fn: (ctx: TestContext) => Promise<T> | T): Promise<T> {
  const ctx = createContext(prefix);
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
    HYDRA_TELEMETRY: process.env.HYDRA_TELEMETRY,
  };
  process.env.HOME = ctx.home;
  process.env.USERPROFILE = ctx.home;
  process.env.HYDRA_HOME = ctx.hydraHome;
  process.env.HYDRA_CONFIG_PATH = ctx.configPath;
  process.env.HYDRA_TELEMETRY = '0';
  try {
    return await fn(ctx);
  } finally {
    restoreEnv(previous);
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createEventLog(ctx: TestContext): EventLog {
  return new EventLog(
    path.join(ctx.hydraHome, 'events.jsonl'),
    path.join(ctx.hydraHome, 'events.state.json'),
  );
}

function createRuntimeStore(ctx: TestContext, eventLog: EventLog): WorkerRuntimeStateStore {
  return new WorkerRuntimeStateStore(
    path.join(ctx.hydraHome, 'worker-runtime-state.json'),
    eventLog,
  );
}

function createWorker(workerId: number, sessionName: string): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'repo',
    sessionName,
    displayName: sessionName,
    workerId,
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: `feat/${sessionName}`,
    slug: sessionName,
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir: '/tmp/hydra-worktree',
    tmuxSession: sessionName,
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: null,
  };
}

async function characterizeStaleNotificationRuntimeRollback(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-runtime-', (ctx) => {
    const eventLog = createEventLog(ctx);
    const runtimeStore = createRuntimeStore(ctx, eventLog);
    const notificationStore = new NotificationStore(
      path.join(ctx.hydraHome, 'notifications.json'),
      1000,
      eventLog,
      runtimeStore,
    );

    const input = {
      kind: 'needs-input' as const,
      title: 'Choose a branch',
      targetSession: 'copilot-runtime',
      sourceSession: 'worker-runtime',
      dedupeKey: 'needs-input:worker-runtime:call-1',
      context: { workerId: 1, agent: 'codex', workdir: '/tmp/hydra-worktree' },
      eventSource: 'hook' as const,
    };
    const original = notificationStore.create(input);
    runtimeStore.set({
      sessionName: 'worker-runtime',
      state: 'running',
      origin: 'manual',
      reason: 'worker-send',
      workerId: 1,
      agent: 'codex',
      workdir: '/tmp/hydra-worktree',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }, 'session-manager');

    const replay = notificationStore.create(input);
    const finalState = runtimeStore.get('worker-runtime');
    return {
      fixed: finalState?.state === 'running',
      detail: [
        `original=${original.notification.id}`,
        `replayCreated=${replay.created}`,
        `finalState=${finalState?.state ?? 'missing'}`,
        `finalUpdatedAt=${finalState?.updatedAt ?? 'missing'}`,
      ].join(' '),
    };
  });
}

async function characterizeEventOnlyNotificationClear(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-event-only-', (ctx) => {
    const eventLog = createEventLog(ctx);
    const store = new NotificationStore(
      path.join(ctx.hydraHome, 'notifications.json'),
      1,
      eventLog,
      createRuntimeStore(ctx, eventLog),
    );
    store.create({
      kind: 'complete',
      title: 'Old worker complete',
      targetSession: 'copilot-events',
      sourceSession: 'worker-event-only',
      dedupeKey: 'complete:worker-event-only:run-1',
      eventSource: 'hook',
    });
    store.create({
      kind: 'info',
      title: 'New retained record',
      targetSession: 'other-session',
      sourceSession: 'other-worker',
      eventSource: 'cli',
    });

    const serviceOptions = {
      debounceMs: 0,
      pollIntervalMs: 50,
      notificationsFile: path.join(ctx.hydraHome, 'notifications.json'),
      eventsFile: path.join(ctx.hydraHome, 'events.jsonl'),
      store,
      eventLog,
    };
    const service = new NotificationStateService(serviceOptions);
    service.initialize();
    const before = service.getLatestSourceCompletion('worker-event-only');
    const clear = service.clear({ sourceSession: 'worker-event-only', kind: 'complete' }, 'cli');
    service.dispose();

    const restarted = new NotificationStateService(serviceOptions);
    restarted.initialize();
    const after = restarted.getLatestSourceCompletion('worker-event-only');
    restarted.dispose();

    return {
      fixed: before !== undefined && after === undefined,
      detail: `before=${before?.id ?? 'missing'} cleared=${clear.cleared} afterRestart=${after?.id ?? 'missing'}`,
    };
  });
}

async function characterizeCodexTurnAbortedResolution(): Promise<ScenarioResult> {
  const transcript = [
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-abort"}}',
    '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-abort","turn_id":"turn-abort","questions":[{"question":"Continue?"}]}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-abort"}}',
  ].join('\n');
  const runtime = classifyCodexRuntimeTranscriptText(transcript);
  const attention = classifyCodexNeedsInputTranscriptText(transcript);
  return {
    fixed: runtime?.state === 'idle' && attention === undefined,
    detail: `runtime=${runtime?.state ?? 'missing'} attention=${attention?.reason ?? 'none'}`,
  };
}

async function characterizeCompletionPendingOverwrite(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-pending-', (ctx) => {
    const sessionName = 'worker-pending-overwrite';
    const manager = new SessionManager(new RecordingBackend());
    const pendingPath = path.join(ctx.hydraHome, 'hooks', `notify-${sessionName}.pending`);
    manager.armCompletionNotification(sessionName);
    const firstToken = fs.readFileSync(pendingPath, 'utf-8').trim();
    manager.armCompletionNotification(sessionName);
    const secondToken = fs.readFileSync(pendingPath, 'utf-8').trim();
    return {
      fixed: firstToken === secondToken,
      detail: `first=${firstToken} second=${secondToken} markerCount=1`,
    };
  });
}

async function characterizeDiffSymlinkEscape(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-diff-', async (ctx) => {
    const workdir = path.join(ctx.root, 'workdir');
    const outside = path.join(ctx.root, 'outside-secret.txt');
    const link = path.join(workdir, 'linked-secret.txt');
    const secret = 'outside-workdir-secret';
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(outside, secret, 'utf-8');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'EPERM' || code === 'EACCES') {
        return { fixed: false, skipped: true, detail: `symlink unavailable: ${code}` };
      }
      throw error;
    }

    try {
      const snapshot = await new DiffService().getFileSnapshot(workdir, 'linked-secret.txt', 'current');
      return {
        fixed: snapshot.content !== secret,
        detail: `exists=${snapshot.exists} leaked=${snapshot.content === secret}`,
      };
    } catch (error) {
      return {
        fixed: true,
        detail: `rejected=${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

async function characterizeForeignTmuxStop(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-foreign-tmux-', async () => {
    const backend = new RecordingBackend();
    const manager = new SessionManager(backend);
    let error: string | undefined;
    try {
      await manager.stopWorker('ordinary-user-tmux');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      fixed: backend.killedSessions.length === 0,
      detail: `killCalls=${backend.killedSessions.length} error=${error ?? 'none'}`,
    };
  });
}

async function characterizeArchiveConcurrentUpdate(): Promise<ScenarioResult> {
  return withContext('hydra-characterize-archive-', async (ctx) => {
    const barrierDir = path.join(ctx.root, 'archive-barrier');
    fs.mkdirSync(barrierDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.hydraHome, 'archive.json'), JSON.stringify({ entries: [] }), 'utf-8');

    const ids = ['writer-a', 'writer-b'];
    const children = ids.map(id => spawn(
      process.execPath,
      [__filename, '--archive-child', id, barrierDir],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ));

    try {
      await waitFor(
        () => ids.every(id => fs.existsSync(path.join(barrierDir, `ready-${id}`))),
        'archive writers to read the same snapshot',
      );
      fs.writeFileSync(path.join(barrierDir, 'go'), 'go', 'utf-8');
      await Promise.all(children.map(waitForChild));
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
    }

    const archive = JSON.parse(
      fs.readFileSync(path.join(ctx.hydraHome, 'archive.json'), 'utf-8'),
    ) as ArchiveState;
    const sessions = archive.entries.map(entry => entry.sessionName).sort();
    return {
      fixed: sessions.length === ids.length,
      detail: `expected=${ids.length} stored=${sessions.length} sessions=${sessions.join(',')}`,
    };
  });
}

function runArchiveWriterChild(id: string, barrierDir: string): void {
  const manager = new SessionManager(new RecordingBackend());
  const internals = manager as unknown as ArchiveInternals;
  const archive = internals.readArchiveState();
  fs.writeFileSync(path.join(barrierDir, `ready-${id}`), 'ready', 'utf-8');
  while (!fs.existsSync(path.join(barrierDir, 'go'))) {
    sleepSync(10);
  }
  archive.entries.push(createArchiveEntry(id));
  internals.writeArchiveState(archive);
}

function createArchiveEntry(id: string): ArchivedSessionInfo {
  return {
    type: 'worker',
    sessionName: id,
    agentSessionId: null,
    agentSessionFile: null,
    archivedAt: new Date().toISOString(),
    data: createWorker(id === 'writer-a' ? 1 : 2, id),
  };
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`archive writer exited ${String(code)}: ${stderr.trim()}`));
      }
    });
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

async function runScenario(
  id: ScenarioId,
  characterize: () => Promise<ScenarioResult>,
): Promise<void> {
  const result = await characterize();
  if (result.skipped) {
    console.log(`[skipped] ${id}: ${result.detail}`);
    return;
  }

  const expected = EXPECTATIONS[id];
  if (expected === 'known-failure') {
    assert.equal(
      result.fixed,
      false,
      `${id} no longer reproduces. Update its expectation and assertions in the fixing PR. ${result.detail}`,
    );
  } else {
    assert.equal(result.fixed, true, `${id} regressed. ${result.detail}`);
  }
  console.log(`[${expected}] ${id}: ${result.detail}`);
}

async function main(): Promise<void> {
  await runScenario('stale-notification-runtime-rollback', characterizeStaleNotificationRuntimeRollback);
  await runScenario('event-only-notification-clear', characterizeEventOnlyNotificationClear);
  await runScenario('codex-turn-aborted-resolution', characterizeCodexTurnAbortedResolution);
  await runScenario('completion-pending-overwrite', characterizeCompletionPendingOverwrite);
  await runScenario('diff-symlink-escape', characterizeDiffSymlinkEscape);
  await runScenario('foreign-tmux-stop', characterizeForeignTmuxStop);
  await runScenario('archive-concurrent-update', characterizeArchiveConcurrentUpdate);
  console.log('workerAttentionCharacterizationSmoke: ok');
}

const archiveChildIndex = process.argv.indexOf('--archive-child');
if (archiveChildIndex >= 0) {
  const id = process.argv[archiveChildIndex + 1];
  const barrierDir = process.argv[archiveChildIndex + 2];
  if (!id || !barrierDir) {
    throw new Error('archive child requires id and barrier directory');
  }
  runArchiveWriterChild(id, barrierDir);
} else {
  void main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
