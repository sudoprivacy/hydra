/**
 * Smoke test: shared worker lifecycle orchestration.
 *
 * Run: node packages/core/out/smoke/workerLifecycleServiceSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventLog } from '../core/events';
import { NotificationStore } from '../core/notifications';
import {
  SessionManager,
  type ArchivedSessionInfo,
  type CreateWorkerResult,
  type DeleteWorkerOpts,
  type SessionState,
  type WorkerInfo,
} from '../core/sessionManager';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';
import { WorkerLifecycleService } from '../core/workerLifecycleService';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';

interface TestContext {
  root: string;
  home: string;
  hydraHome: string;
  configPath: string;
  eventLog: EventLog;
  notificationStore: NotificationStore;
  runtimeStateStore: WorkerRuntimeStateStore;
}

type OperationError =
  | 'start'
  | 'stop'
  | 'delete'
  | 'rename'
  | 'restore';

class RecordingBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'recording-backend';
  readonly installHint = 'not needed';
  readonly sent: Array<{ sessionName: string; message: string }> = [];
  sendError: Error | null = null;
  onSend: ((sessionName: string, message: string) => void) | undefined;

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> { return []; }
  async createSession(): Promise<void> {}
  async killSession(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async hasSession(): Promise<boolean> { return true; }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<HydraRole | undefined> { return 'worker'; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return 'codex'; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> { return ''; }
  async sendMessage(sessionName: string, message: string): Promise<void> {
    this.onSend?.(sessionName, message);
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push({ sessionName, message });
  }
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

class FakeSessionManager extends SessionManager {
  readonly workers = new Map<string, WorkerInfo>();
  readonly archived = new Map<string, ArchivedSessionInfo>();
  readonly pending = new Set<string>();
  readonly armCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly deleteCalls: Array<{ sessionName: string; options: DeleteWorkerOpts }> = [];
  readonly renameCalls: Array<{ sessionName: string; branch: string }> = [];
  liveLookupCalls = 0;
  ownershipError: Error | null = null;
  cancelError: Error | null = null;
  postCreateError: Error | null = null;
  operationErrors = new Map<OperationError, Error>();

  constructor(backend: MultiplexerBackendCore, workers: WorkerInfo[]) {
    super(backend);
    for (const worker of workers) {
      this.workers.set(worker.sessionName, worker);
      this.archived.set(worker.sessionName, {
        type: 'worker',
        sessionName: worker.sessionName,
        agentSessionId: worker.sessionId,
        archivedAt: new Date().toISOString(),
        data: worker,
      });
    }
  }

  override async sync(): Promise<SessionState> {
    return this.buildState();
  }

  override async listWorkers(repoRoot?: string): Promise<WorkerInfo[]> {
    this.liveLookupCalls += 1;
    const workers = [...this.workers.values()];
    return repoRoot ? workers.filter(worker => worker.repoRoot === repoRoot) : workers;
  }

  override listPersistedWorkers(): WorkerInfo[] {
    return [...this.workers.values()];
  }

  override async getWorker(sessionName: string): Promise<WorkerInfo | undefined> {
    this.liveLookupCalls += 1;
    return this.workers.get(sessionName);
  }

  override getPersistedWorker(sessionName: string): WorkerInfo | undefined {
    return this.workers.get(sessionName);
  }

  override async assertHydraSessionOwnership(
    sessionName: string,
    expectedKind?: 'worker' | 'copilot',
  ): Promise<{ kind: 'worker' | 'copilot'; live: boolean }> {
    if (this.ownershipError) {
      throw this.ownershipError;
    }
    if (expectedKind !== undefined && expectedKind !== 'worker') {
      throw new Error(`Unexpected ownership kind: ${expectedKind}`);
    }
    if (!this.workers.has(sessionName)) {
      throw new Error(`Refusing to control unknown Hydra worker "${sessionName}"`);
    }
    return { kind: 'worker', live: true };
  }

  override armCompletionNotification(sessionName: string): boolean {
    this.armCalls.push(sessionName);
    const created = !this.pending.has(sessionName);
    this.pending.add(sessionName);
    return created;
  }

  override cancelCompletionNotification(sessionName: string): boolean {
    this.cancelCalls.push(sessionName);
    if (this.cancelError) {
      throw this.cancelError;
    }
    return this.pending.delete(sessionName);
  }

  override async createWorker(): Promise<CreateWorkerResult> {
    return this.createResult(this.firstWorker());
  }

  override async createDirectoryWorker(): Promise<CreateWorkerResult> {
    return this.createResult(this.firstWorker());
  }

  override async startWorker(sessionName: string): Promise<CreateWorkerResult> {
    this.throwOperationError('start');
    return this.createResult(this.requireWorker(sessionName));
  }

  override async stopWorker(sessionName: string): Promise<void> {
    this.throwOperationError('stop');
    this.stopCalls.push(sessionName);
    const worker = this.requireWorker(sessionName);
    this.workers.set(sessionName, { ...worker, status: 'stopped', attached: false });
  }

  override async deleteWorker(sessionName: string, options: DeleteWorkerOpts = {}): Promise<void> {
    this.throwOperationError('delete');
    this.deleteCalls.push({ sessionName, options });
    this.workers.delete(sessionName);
  }

  override async renameWorker(sessionName: string, newBranchName: string): Promise<WorkerInfo> {
    this.throwOperationError('rename');
    this.renameCalls.push({ sessionName, branch: newBranchName });
    return { ...this.requireWorker(sessionName), branch: newBranchName };
  }

  override getArchived(sessionName: string): ArchivedSessionInfo | undefined {
    return this.archived.get(sessionName);
  }

  override async restoreWorker(sessionName: string): Promise<CreateWorkerResult> {
    this.throwOperationError('restore');
    return this.createResult(this.requireWorker(sessionName));
  }

  private buildState(): SessionState {
    return {
      copilots: {},
      workers: Object.fromEntries(this.workers),
      nextWorkerId: Math.max(0, ...[...this.workers.values()].map(worker => worker.workerId)) + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  private createResult(workerInfo: WorkerInfo): CreateWorkerResult {
    return {
      workerInfo,
      postCreatePromise: this.postCreateError
        ? Promise.reject(this.postCreateError)
        : Promise.resolve(),
    };
  }

  private firstWorker(): WorkerInfo {
    const worker = this.workers.values().next().value as WorkerInfo | undefined;
    if (!worker) {
      throw new Error('FakeSessionManager requires at least one worker');
    }
    return worker;
  }

  private requireWorker(sessionName: string): WorkerInfo {
    const worker = this.workers.get(sessionName);
    if (!worker) {
      throw new Error(`Worker "${sessionName}" not found`);
    }
    return worker;
  }

  private throwOperationError(operation: OperationError): void {
    const error = this.operationErrors.get(operation);
    if (error) {
      throw error;
    }
  }
}

function createContext(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-lifecycle-'));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  const eventLog = new EventLog(
    path.join(hydraHome, 'events.jsonl'),
    path.join(hydraHome, 'events.state.json'),
  );
  const runtimeStateStore = new WorkerRuntimeStateStore(
    path.join(hydraHome, 'worker-runtime-state.json'),
    eventLog,
  );
  const notificationStore = new NotificationStore(
    path.join(hydraHome, 'notifications.json'),
    1000,
    eventLog,
    runtimeStateStore,
  );
  return { root, home, hydraHome, configPath, eventLog, notificationStore, runtimeStateStore };
}

async function withContext<T>(fn: (ctx: TestContext) => Promise<T>): Promise<T> {
  const ctx = createContext();
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

function createWorker(workerId: number, sessionName: string, overrides: Partial<WorkerInfo> = {}): WorkerInfo {
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
    workdir: `/tmp/${sessionName}`,
    tmuxSession: sessionName,
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: 'copilot-parent',
    ...overrides,
  };
}

function createService(
  ctx: TestContext,
  backend: MultiplexerBackendCore,
  sessionManager: SessionManager,
): WorkerLifecycleService {
  return new WorkerLifecycleService({
    backend,
    sessionManager,
    notificationStore: ctx.notificationStore,
    runtimeStateStore: ctx.runtimeStateStore,
    eventSource: 'cli',
  });
}

async function testPostCreateErrorsPublishOnce(): Promise<void> {
  await withContext(async (ctx) => {
    const cases = ['create', 'create-directory', 'start', 'restore'] as const;
    for (const [index, operation] of cases.entries()) {
      const worker = createWorker(index + 1, `worker-post-create-${operation}`);
      const backend = new RecordingBackend();
      const manager = new FakeSessionManager(backend, [worker]);
      manager.postCreateError = new Error(`post-create failure for ${operation}`);
      const service = createService(ctx, backend, manager);

      let result: CreateWorkerResult;
      if (operation === 'create') {
        result = await service.createWorker({ repoRoot: '/tmp/hydra', branchName: 'feat/test' });
      } else if (operation === 'create-directory') {
        result = await service.createDirectoryWorker({ workdir: '/tmp/task', name: 'task' });
      } else if (operation === 'start') {
        result = await service.startWorker(worker.sessionName);
      } else {
        result = await service.restoreWorker(worker.sessionName);
      }

      await assert.rejects(result.postCreatePromise, new RegExp(`post-create failure for ${operation}`));
      const notifications = ctx.notificationStore.list({ sourceSession: worker.sessionName }).notifications;
      assert.equal(notifications.length, 1, `${operation} should publish exactly one startup error`);
      assert.equal(notifications[0].kind, 'error');
    }
  });
}

async function testSendOrderingAndCompletionIntent(): Promise<void> {
  await withContext(async (ctx) => {
    const worker = createWorker(11, 'worker-send-order');
    const backend = new RecordingBackend();
    const manager = new FakeSessionManager(backend, [worker]);
    const service = createService(ctx, backend, manager);

    backend.onSend = (sessionName) => {
      assert.equal(sessionName, worker.sessionName);
      assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.state, 'running');
      assert.deepEqual(manager.armCalls, [worker.sessionName]);
    };

    const result = await service.sendWorkerMessage(worker.workerId, 'Implement the change', {
      actorSessionName: worker.copilotSessionName,
    });

    assert.equal(result.worker.sessionName, worker.sessionName);
    assert.equal(result.completionArmed, true);
    assert.equal(manager.liveLookupCalls, 0, 'persisted worker lookup must not reconcile away mutation targets');
    assert.equal(manager.pending.has(worker.sessionName), true);
    assert.deepEqual(backend.sent, [{ sessionName: worker.sessionName, message: 'Implement the change' }]);
    assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.reason, 'worker-send');
  });
}

async function testDeliveryFailureCleanup(): Promise<void> {
  await withContext(async (ctx) => {
    const newWorker = createWorker(21, 'worker-delivery-new');
    const existingWorker = createWorker(22, 'worker-delivery-existing');
    const backend = new RecordingBackend();
    backend.sendError = new Error('simulated backend delivery failure');
    const manager = new FakeSessionManager(backend, [newWorker, existingWorker]);
    manager.pending.add(existingWorker.sessionName);
    const service = createService(ctx, backend, manager);

    await assert.rejects(
      service.sendWorkerMessage(newWorker.sessionName, 'new run', {
        actorSessionName: newWorker.copilotSessionName,
      }),
      /simulated backend delivery failure/,
    );
    assert.equal(manager.pending.has(newWorker.sessionName), false);
    assert.deepEqual(manager.cancelCalls, [newWorker.sessionName]);
    assert.equal(ctx.runtimeStateStore.get(newWorker.sessionName)?.state, 'error');
    const created = ctx.notificationStore.list({ sourceSession: newWorker.sessionName }).notifications;
    assert.equal(created.length, 1);
    assert.match(created[0].title, /failed to receive a message/);

    await assert.rejects(
      service.sendWorkerMessage(existingWorker.sessionName, 'continue old run', {
        actorSessionName: existingWorker.copilotSessionName,
      }),
      /simulated backend delivery failure/,
    );
    assert.equal(manager.pending.has(existingWorker.sessionName), true);
    assert.deepEqual(
      manager.cancelCalls,
      [newWorker.sessionName],
      'delivery failure must not cancel completion intent that predated this send',
    );
  });
}

async function testStopDeleteAndBroadcast(): Promise<void> {
  await withContext(async (ctx) => {
    const stoppedWorker = createWorker(31, 'worker-stop');
    const deletedWorker = createWorker(32, 'worker-delete');
    const broadcastWorker = createWorker(33, 'worker-broadcast');
    const ignoredWorker = createWorker(34, 'worker-stopped', { status: 'stopped' });
    const backend = new RecordingBackend();
    const manager = new FakeSessionManager(
      backend,
      [stoppedWorker, deletedWorker, broadcastWorker, ignoredWorker],
    );
    manager.pending.add(stoppedWorker.sessionName);
    manager.pending.add(deletedWorker.sessionName);
    const service = createService(ctx, backend, manager);

    await service.stopWorker(stoppedWorker.sessionName);
    await service.deleteWorker(deletedWorker.workerId, { deleteFiles: true });
    assert.equal(manager.pending.has(stoppedWorker.sessionName), false);
    assert.equal(manager.pending.has(deletedWorker.sessionName), false);
    assert.deepEqual(manager.stopCalls, [stoppedWorker.sessionName]);
    assert.deepEqual(manager.deleteCalls, [{
      sessionName: deletedWorker.sessionName,
      options: { deleteFiles: true },
    }]);

    const broadcast = await service.broadcastToWorkers('status update');
    assert.deepEqual(
      broadcast.workers.map(worker => worker.sessionName),
      [broadcastWorker.sessionName],
    );
    assert.equal(
      backend.sent.some(entry => entry.sessionName === ignoredWorker.sessionName),
      false,
    );
    for (const worker of broadcast.workers) {
      assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.reason, 'worker-broadcast');
    }
  });
}

async function testCleanupFailureDoesNotMaskLifecycleOutcome(): Promise<void> {
  await withContext(async (ctx) => {
    const worker = createWorker(35, 'worker-cleanup-failure');
    const backend = new RecordingBackend();
    backend.sendError = new Error('original delivery failure');
    const manager = new FakeSessionManager(backend, [worker]);
    manager.cancelError = new Error('completion cleanup failure');
    const service = createService(ctx, backend, manager);

    await assert.rejects(
      service.sendWorkerMessage(worker.sessionName, 'message', {
        actorSessionName: worker.copilotSessionName,
      }),
      /original delivery failure/,
    );
    assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.state, 'error');
    assert.equal(ctx.notificationStore.list({ sourceSession: worker.sessionName }).count, 1);

    backend.sendError = null;
    manager.pending.add(worker.sessionName);
    await service.stopWorker(worker.sessionName);
    assert.deepEqual(manager.stopCalls, [worker.sessionName]);
  });
}

async function testUnknownAndForeignWorkersFailClosed(): Promise<void> {
  await withContext(async (ctx) => {
    const worker = createWorker(41, 'worker-owned');
    const backend = new RecordingBackend();
    const manager = new FakeSessionManager(backend, [worker]);
    const service = createService(ctx, backend, manager);

    await assert.rejects(service.sendWorkerMessage('missing-worker', 'message'), /not found/);
    assert.equal(backend.sent.length, 0);

    manager.ownershipError = new Error('Refusing to control foreign tmux session');
    await assert.rejects(
      service.sendWorkerMessage(worker.sessionName, 'message'),
      /Refusing to control foreign tmux session/,
    );
    assert.equal(backend.sent.length, 0);
    assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.state, 'error');
  });
}

async function testLifecycleErrorTitles(): Promise<void> {
  await withContext(async (ctx) => {
    const cases: Array<{
      operation: OperationError;
      expectedTitle: RegExp;
    }> = [
      { operation: 'start', expectedTitle: /failed to start/ },
      { operation: 'stop', expectedTitle: /failed to stop/ },
      { operation: 'delete', expectedTitle: /failed to delete/ },
      { operation: 'rename', expectedTitle: /failed to rename/ },
      { operation: 'restore', expectedTitle: /failed to restore/ },
    ];

    for (const [index, testCase] of cases.entries()) {
      const worker = createWorker(50 + index, `worker-error-${testCase.operation}`);
      const backend = new RecordingBackend();
      const manager = new FakeSessionManager(backend, [worker]);
      manager.operationErrors.set(
        testCase.operation,
        new Error(`simulated ${testCase.operation} lifecycle failure`),
      );
      const service = createService(ctx, backend, manager);

      const operation = (() => {
        switch (testCase.operation) {
          case 'start':
            return service.startWorker(worker.sessionName);
          case 'stop':
            return service.stopWorker(worker.sessionName);
          case 'delete':
            return service.deleteWorker(worker.sessionName);
          case 'rename':
            return service.renameWorker(worker.sessionName, 'feat/renamed');
          case 'restore':
            return service.restoreWorker(worker.sessionName);
        }
      })();

      await assert.rejects(operation, new RegExp(`simulated ${testCase.operation}`));
      const notifications = ctx.notificationStore.list({ sourceSession: worker.sessionName }).notifications;
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].title, testCase.expectedTitle);
      assert.equal(ctx.runtimeStateStore.get(worker.sessionName)?.state, 'error');
    }
  });
}

async function main(): Promise<void> {
  await testPostCreateErrorsPublishOnce();
  await testSendOrderingAndCompletionIntent();
  await testDeliveryFailureCleanup();
  await testStopDeleteAndBroadcast();
  await testCleanupFailureDoesNotMaskLifecycleOutcome();
  await testUnknownAndForeignWorkersFailClosed();
  await testLifecycleErrorTitles();
  console.log('workerLifecycleServiceSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
