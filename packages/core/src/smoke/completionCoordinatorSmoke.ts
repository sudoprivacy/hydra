/**
 * Smoke test: normalized completion coordination.
 *
 * Run: node packages/core/out/smoke/completionCoordinatorSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CompletionCoordinator,
  type CompletionWorkerIdentity,
} from '../core/completionCoordinator';
import { CompletionJobStore } from '../core/completionJobStore';
import { EventLog } from '../core/events';
import { NotificationStore, type CreateNotificationInput } from '../core/notifications';
import type { WorkerInfo } from '../core/sessionManager';
import { WorkerRuntimeCoordinator } from '../core/workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '../core/workerRuntimeV2';

interface TestContext {
  root: string;
  hydraHome: string;
  eventLog: EventLog;
  jobStore: CompletionJobStore;
  runtimeStore: WorkerRuntimeStateStoreV2;
  compatibilityStore: WorkerRuntimeStateStore;
  notificationStore: NotificationStore;
  worker: CompletionWorkerIdentity;
  deliveries: Array<{ target: string; message: string }>;
}

class FailingNotificationStore extends NotificationStore {
  failuresRemaining = 1;

  override create(input: CreateNotificationInput): ReturnType<NotificationStore['create']> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated notification write failure');
    }
    return super.create(input);
  }
}

class FailingMarkFiredStore extends CompletionJobStore {
  failuresRemaining = 1;

  override markFired(
    ...args: Parameters<CompletionJobStore['markFired']>
  ): ReturnType<CompletionJobStore['markFired']> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated mark-fired failure');
    }
    return super.markFired(...args);
  }
}

function createWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'repo',
    sessionName: 'worker-completion',
    displayName: 'feat/completion',
    workerId: 7,
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: 'feat/completion',
    slug: 'feat-completion',
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir: '/tmp/hydra-completion',
    tmuxSession: 'worker-completion',
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: 'copilot-current',
    ...overrides,
  };
}

function createContext(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-coordinator-'));
  const hydraHome = path.join(root, 'hydra');
  fs.mkdirSync(hydraHome, { recursive: true });
  const eventLog = new EventLog(
    path.join(hydraHome, 'events.jsonl'),
    path.join(hydraHome, 'events.state.json'),
  );
  const runtimeStore = new WorkerRuntimeStateStoreV2(path.join(hydraHome, 'worker-runtime-state-v2.json'));
  const compatibilityStore = new WorkerRuntimeStateStore(
    path.join(hydraHome, 'worker-runtime-state.json'),
    eventLog,
  );
  const notificationStore = new NotificationStore(
    path.join(hydraHome, 'notifications.json'),
    1000,
    eventLog,
    compatibilityStore,
    Date.now,
    undefined,
    runtimeStore,
  );
  return {
    root,
    hydraHome,
    eventLog,
    jobStore: new CompletionJobStore(path.join(hydraHome, 'completion-jobs.json')),
    runtimeStore,
    compatibilityStore,
    notificationStore,
    worker: { worker: createWorker(), lifecycleEpoch: 'epoch-7' },
    deliveries: [],
  };
}

function createRuntimeCoordinator(ctx: TestContext): WorkerRuntimeCoordinator {
  return new WorkerRuntimeCoordinator(
    workerId => workerId === ctx.worker.worker.workerId ? {
      workerId,
      sessionName: ctx.worker.worker.sessionName,
      lifecycleEpoch: ctx.worker.lifecycleEpoch,
      agent: ctx.worker.worker.agent,
      workdir: ctx.worker.worker.workdir,
    } : undefined,
    ctx.runtimeStore,
    ctx.compatibilityStore,
    ctx.eventLog,
  );
}

function createCoordinator(
  ctx: TestContext,
  overrides: {
    jobStore?: CompletionJobStore;
    notificationStore?: NotificationStore;
    readLegacyPendingToken?: (sessionName: string) => string | undefined;
    deliverCompatibility?: (targetSession: string, message: string) => Promise<void>;
  } = {},
): CompletionCoordinator {
  return new CompletionCoordinator({
    resolveWorker: workerId => workerId === ctx.worker.worker.workerId ? ctx.worker : undefined,
    jobStore: overrides.jobStore ?? ctx.jobStore,
    runtimeStore: ctx.runtimeStore,
    runtimeCoordinator: createRuntimeCoordinator(ctx),
    notificationStore: overrides.notificationStore ?? ctx.notificationStore,
    deliverCompatibility: overrides.deliverCompatibility ?? (async (target, message) => {
      ctx.deliveries.push({ target, message });
    }),
    eventSource: 'hook',
    readLegacyPendingToken: overrides.readLegacyPendingToken ?? (() => undefined),
  });
}

function seedRunning(ctx: TestContext, runId = 'run-7'): void {
  const result = createRuntimeCoordinator(ctx).apply({
    workerId: ctx.worker.worker.workerId,
    sessionName: ctx.worker.worker.sessionName,
    lifecycleEpoch: ctx.worker.lifecycleEpoch,
    runId,
    revision: 0,
    state: 'running',
    signalId: `dispatch:${runId}`,
    origin: 'lifecycle',
    reason: 'worker-send',
    observedAt: '2026-07-10T00:00:00.000Z',
    agent: ctx.worker.worker.agent,
    workdir: ctx.worker.worker.workdir,
  }, 'cli');
  assert.equal(result.outcome, 'applied');
}

function arm(ctx: TestContext, runId = 'run-7', store = ctx.jobStore): string {
  const result = store.armForDispatch({
    workerId: ctx.worker.worker.workerId,
    lifecycleEpoch: ctx.worker.lifecycleEpoch,
    runId,
  }, {
    runtimeActive: true,
    runtimeRunId: runId,
  });
  return result.job.jobId;
}

async function testCompletionAndIdempotency(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx);
    const jobId = arm(ctx);
    const coordinator = createCoordinator(ctx);
    const first = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    const duplicate = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });

    assert.equal(first.outcome, 'completed');
    assert.equal(first.job?.jobId, jobId);
    assert.equal(first.job?.status, 'fired');
    assert.equal(first.runtime?.state, 'idle');
    assert.equal(first.runtime?.runId, 'run-7');
    assert.equal(first.notification?.kind, 'complete');
    assert.equal(first.notification?.sourceSession, 'worker-completion');
    assert.equal(first.notification?.targetSession, 'copilot-current');
    assert.equal(first.compatibilityDelivered, true);
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(ctx.notificationStore.listOccurrences().length, 1);
    assert.equal(ctx.deliveries.length, 1);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function testNotificationFailureRepairsOnRetry(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx, 'run-notification-retry');
    arm(ctx, 'run-notification-retry');
    const failingStore = new FailingNotificationStore(
      path.join(ctx.hydraHome, 'notifications.json'),
      1000,
      ctx.eventLog,
      ctx.compatibilityStore,
      Date.now,
      undefined,
      ctx.runtimeStore,
    );
    const coordinator = createCoordinator(ctx, { notificationStore: failingStore });

    await assert.rejects(
      coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' }),
      /simulated notification write failure/,
    );
    assert.equal(ctx.runtimeStore.get(7)?.state, 'idle');
    assert.equal(ctx.jobStore.getPending(7)?.status, 'pending');

    const repaired = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(repaired.outcome, 'completed');
    assert.equal(repaired.runtimeOutcome, 'duplicate');
    assert.equal(repaired.job?.status, 'fired');
    assert.equal(failingStore.listOccurrences().length, 1);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function testMarkFiredFailureRepairsOnRetry(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx, 'run-fire-retry');
    const jobStore = new FailingMarkFiredStore(path.join(ctx.hydraHome, 'completion-jobs.json'));
    arm(ctx, 'run-fire-retry', jobStore);
    const coordinator = createCoordinator(ctx, { jobStore });

    await assert.rejects(
      coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' }),
      /simulated mark-fired failure/,
    );
    assert.equal(jobStore.getPending(7)?.status, 'pending');
    assert.equal(ctx.notificationStore.listOccurrences().length, 1);

    const repaired = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(repaired.outcome, 'duplicate');
    assert.equal(repaired.job?.status, 'fired');
    assert.equal(ctx.notificationStore.listOccurrences().length, 1);
    assert.equal(ctx.deliveries.length, 0, 'compatibility delivery is not retried after durable notification creation');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function testCurrentRoutingAndGlobalOccurrence(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx, 'run-route');
    arm(ctx, 'run-route');
    ctx.worker = {
      lifecycleEpoch: 'epoch-7',
      worker: createWorker({
        sessionName: 'worker-renamed',
        tmuxSession: 'worker-renamed',
        branch: 'feat/renamed',
        copilotSessionName: 'copilot-new-parent',
      }),
    };
    const routed = await createCoordinator(ctx).complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(routed.outcome, 'completed');
    assert.equal(routed.notification?.sourceSession, 'worker-renamed');
    assert.equal(routed.notification?.targetSession, 'copilot-new-parent');
    assert.equal(routed.notification?.action?.session, 'worker-renamed');
    assert.equal(ctx.deliveries[0]?.target, 'copilot-new-parent');

    const globalCtx = createContext();
    try {
      globalCtx.worker = {
        ...globalCtx.worker,
        worker: createWorker({ copilotSessionName: null }),
      };
      seedRunning(globalCtx, 'run-global');
      arm(globalCtx, 'run-global');
      const global = await createCoordinator(globalCtx).complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
      assert.equal(global.outcome, 'completed');
      assert.equal(global.notification?.targetSession, null);
      assert.equal(globalCtx.notificationStore.listOccurrences('active').length, 1);
      assert.equal(globalCtx.deliveries.length, 0);
    } finally {
      fs.rmSync(globalCtx.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function testLegacyPendingReadOnlyMigration(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx, 'run-legacy');
    let reads = 0;
    const coordinator = createCoordinator(ctx, {
      readLegacyPendingToken: () => {
        reads += 1;
        return 'legacy-token';
      },
    });
    const result = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.migratedLegacyPending, true);
    assert.equal(result.job?.runId, 'run-legacy');
    assert.equal(result.job?.status, 'fired');
    assert.equal(reads, 1);

    const current = ctx.runtimeStore.get(7)!;
    const nextRun = createRuntimeCoordinator(ctx).apply({
      workerId: 7,
      sessionName: ctx.worker.worker.sessionName,
      lifecycleEpoch: 'epoch-7',
      runId: 'run-after-legacy',
      revision: current.revision + 1,
      state: 'running',
      signalId: 'dispatch-after-legacy',
      origin: 'lifecycle',
      reason: 'worker-send',
      observedAt: '2026-07-10T00:01:00.000Z',
      agent: ctx.worker.worker.agent,
      workdir: ctx.worker.worker.workdir,
    }, 'cli');
    assert.equal(nextRun.outcome, 'applied');
    const staleMarkerReplay = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(staleMarkerReplay.outcome, 'no-pending-job');
    assert.equal(ctx.jobStore.list().length, 1, 'legacy marker must be migrated at most once');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function testRejectionsAndBestEffortDelivery(): Promise<void> {
  const ctx = createContext();
  try {
    seedRunning(ctx, 'run-rejections');
    arm(ctx, 'run-rejections');
    const coordinator = createCoordinator(ctx, {
      deliverCompatibility: async () => {
        throw new Error('simulated compatibility delivery failure');
      },
    });
    const stale = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'old-epoch' });
    assert.equal(stale.outcome, 'stale-epoch');
    assert.equal(ctx.runtimeStore.get(7)?.state, 'running');

    const completed = await coordinator.complete({ workerId: 7, lifecycleEpoch: 'epoch-7' });
    assert.equal(completed.outcome, 'completed');
    assert.equal(completed.compatibilityDelivered, false);
    assert.equal(completed.job?.status, 'fired');
    assert.equal(ctx.notificationStore.listOccurrences().length, 1);

    const missing = await coordinator.complete({ workerId: 999, lifecycleEpoch: 'epoch-999' });
    assert.equal(missing.outcome, 'worker-not-found');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testCompletionAndIdempotency();
  await testNotificationFailureRepairsOnRetry();
  await testMarkFiredFailureRepairsOnRetry();
  await testCurrentRoutingAndGlobalOccurrence();
  await testLegacyPendingReadOnlyMigration();
  await testRejectionsAndBestEffortDelivery();
  console.log('completionCoordinatorSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
