import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventLog } from '../core/events';
import {
  applyLegacyWorkerRuntimeState,
  WorkerRuntimeCoordinator,
  type WorkerRuntimeIdentity,
  type WorkerRuntimeV1ProjectionStore,
} from '../core/workerRuntimeCoordinator';
import {
  WorkerRuntimeStateStore,
  type SetWorkerRuntimeStateInput,
  type SetWorkerRuntimeStateResult,
  type WorkerRuntimeSnapshot,
} from '../core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2, type WorkerRuntimeSignalV2 } from '../core/workerRuntimeV2';

interface TestRuntime {
  root: string;
  v2Path: string;
  v1: WorkerRuntimeStateStore;
  v2: WorkerRuntimeStateStoreV2;
  coordinator: WorkerRuntimeCoordinator;
  getIdentity(): WorkerRuntimeIdentity | undefined;
  setIdentity(identity: WorkerRuntimeIdentity | undefined): void;
}

class FailingCompatibilityStore implements WorkerRuntimeV1ProjectionStore {
  private readonly snapshots = new Map<string, WorkerRuntimeSnapshot>();
  failNextProject = false;
  failNextClearFor: string | undefined;
  onClear: ((sessionName: string) => void) | undefined;

  get(sessionName: string): WorkerRuntimeSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionName);
    return snapshot ? { ...snapshot } : undefined;
  }

  project(input: SetWorkerRuntimeStateInput): SetWorkerRuntimeStateResult {
    if (this.failNextProject) {
      this.failNextProject = false;
      throw new Error('injected compatibility projection failure');
    }
    const snapshot = compatibilitySnapshot(input);
    this.snapshots.set(snapshot.sessionName, snapshot);
    return { snapshot: { ...snapshot }, changed: true };
  }

  set(input: SetWorkerRuntimeStateInput): SetWorkerRuntimeStateResult {
    return this.project(input);
  }

  clear(sessionName: string): boolean {
    this.onClear?.(sessionName);
    if (this.failNextClearFor === sessionName) {
      this.failNextClearFor = undefined;
      throw new Error('injected compatibility clear failure');
    }
    return this.snapshots.delete(sessionName);
  }
}

function signal(overrides: Partial<WorkerRuntimeSignalV2> = {}): WorkerRuntimeSignalV2 {
  return {
    workerId: 7,
    sessionName: 'repo_worker',
    lifecycleEpoch: 'epoch-1',
    runId: 'run-1',
    revision: 1,
    state: 'running',
    signalId: 'signal-1',
    origin: 'lifecycle',
    reason: 'worker-dispatched',
    observedAt: '2026-07-10T00:00:00.000Z',
    agent: 'codex',
    workdir: '/tmp/repo-worker',
    ...overrides,
  };
}

function createRuntime(prefix = 'hydra-runtime-v2-'): TestRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const v2Path = path.join(root, 'worker-runtime-state-v2.json');
  const v2 = new WorkerRuntimeStateStoreV2(v2Path);
  const v1 = new WorkerRuntimeStateStore(
    path.join(root, 'worker-runtime-state.json'),
    new EventLog(path.join(root, 'v1-events.jsonl'), path.join(root, 'v1-events.state.json')),
  );
  const eventLog = new EventLog(path.join(root, 'events.jsonl'), path.join(root, 'events.state.json'));
  let identity: WorkerRuntimeIdentity | undefined = {
    workerId: 7,
    sessionName: 'repo_worker',
    lifecycleEpoch: 'epoch-1',
    agent: 'codex',
    workdir: '/tmp/repo-worker',
  };
  return {
    root,
    v2Path,
    v1,
    v2,
    coordinator: new WorkerRuntimeCoordinator(
      workerId => identity?.workerId === workerId ? identity : undefined,
      v2,
      v1,
      eventLog,
    ),
    getIdentity: () => identity,
    setIdentity: next => { identity = next; },
  };
}

function testOrderingEpochRunAndDedupe(): void {
  const runtime = createRuntime();
  try {
    assert.equal(runtime.coordinator.apply(signal()).outcome, 'applied');
    assert.equal(runtime.coordinator.apply(signal()).outcome, 'duplicate');

    const staleRevision = signal({ revision: 0, signalId: 'signal-old' });
    assert.equal(runtime.coordinator.apply(staleRevision).outcome, 'stale-revision');
    assert.equal(runtime.coordinator.apply(staleRevision).outcome, 'duplicate');

    assert.equal(runtime.coordinator.apply(signal({ revision: 2, signalId: 'signal-seq', sourceSequence: 5 })).outcome, 'applied');
    assert.equal(runtime.coordinator.apply(signal({ revision: 3, signalId: 'signal-unsequenced' })).outcome, 'applied');
    assert.equal(runtime.v2.get(7)?.sourceSequence, 5);
    const staleSequence = signal({ revision: 4, signalId: 'signal-stale-seq', sourceSequence: 4 });
    assert.equal(runtime.coordinator.apply(staleSequence).outcome, 'stale-revision');
    assert.equal(runtime.coordinator.apply(staleSequence).outcome, 'duplicate');

    const staleRun = signal({ revision: 4, signalId: 'signal-stale-run', runId: 'run-old' });
    assert.equal(runtime.coordinator.apply(staleRun).outcome, 'stale-run');
    assert.equal(runtime.coordinator.apply(staleRun).outcome, 'duplicate');

    assert.equal(runtime.coordinator.apply(signal({ revision: 4, signalId: 'signal-complete', state: 'idle' })).outcome, 'applied');
    const illegalNeedsInput = signal({ revision: 5, signalId: 'signal-illegal-needs-input', state: 'needs-input', runId: 'run-2' });
    assert.equal(runtime.coordinator.apply(illegalNeedsInput).outcome, 'illegal-transition');
    assert.equal(runtime.coordinator.apply(signal({ revision: 5, signalId: 'signal-new-run', runId: 'run-2' })).outcome, 'applied');
    assert.equal(runtime.coordinator.apply(illegalNeedsInput).outcome, 'duplicate');

    assert.equal(runtime.coordinator.apply(signal({ revision: 6, signalId: 'signal-missing-run', state: 'needs-input', runId: null })).outcome, 'stale-run');
    assert.equal(runtime.coordinator.apply(signal({ revision: 7, signalId: 'signal-wrong-end-run', state: 'idle', runId: 'run-wrong' })).outcome, 'stale-run');
    assert.equal(runtime.coordinator.apply(signal({ revision: 8, signalId: 'signal-end-run', state: 'idle', runId: 'run-2' })).outcome, 'applied');
    const lateOldRun = signal({ revision: 9, signalId: 'signal-late-old-run', state: 'error', runId: 'run-1' });
    assert.equal(runtime.coordinator.apply(lateOldRun).outcome, 'stale-run');
    assert.equal(runtime.coordinator.apply(lateOldRun).outcome, 'duplicate');
    assert.equal(runtime.v2.get(7)?.state, 'idle');
    assert.equal(runtime.v2.get(7)?.runId, 'run-2');

    runtime.setIdentity({ ...runtime.getIdentity()!, lifecycleEpoch: 'epoch-2' });
    assert.equal(runtime.coordinator.apply(signal({ revision: 9, signalId: 'signal-old-epoch' })).outcome, 'stale-epoch');
    assert.equal(runtime.coordinator.apply(signal({ lifecycleEpoch: 'epoch-2', revision: 0, signalId: 'signal-new-epoch-question', state: 'needs-input', runId: 'run-3' })).outcome, 'illegal-transition');
    assert.equal(runtime.coordinator.apply(signal({ lifecycleEpoch: 'epoch-2', revision: 0, signalId: 'signal-new-epoch-running', runId: 'run-3' })).outcome, 'applied');

    runtime.setIdentity(undefined);
    assert.equal(runtime.coordinator.apply(signal({ lifecycleEpoch: 'epoch-2', revision: 1, signalId: 'signal-missing' })).outcome, 'worker-not-found');
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function testRejectedSignalNeverResurrectsAfterHistoryGrowth(): void {
  const runtime = createRuntime('hydra-runtime-v2-durable-dedupe-');
  try {
    assert.equal(runtime.coordinator.apply(signal({ state: 'idle', runId: null, revision: 2, signalId: 'idle-first' })).outcome, 'applied');
    const rejected = signal({ state: 'needs-input', runId: 'run-2', revision: 1000, signalId: 'future-question' });
    assert.equal(runtime.coordinator.apply(rejected).outcome, 'illegal-transition');
    assert.equal(runtime.coordinator.apply(signal({ runId: 'run-2', revision: 3, signalId: 'start-run-2' })).outcome, 'applied');
    for (let revision = 4; revision < 304; revision += 1) {
      assert.equal(runtime.coordinator.apply(signal({ runId: 'run-2', revision, signalId: `same-state-${revision}` })).outcome, 'applied');
    }
    assert.equal(runtime.coordinator.apply(rejected).outcome, 'duplicate');
    assert.equal(runtime.v2.get(7)?.state, 'running');
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function testEpochFirstIdleAndError(): void {
  for (const state of ['idle', 'error'] as const) {
    const runtime = createRuntime(`hydra-runtime-v2-${state}-`);
    try {
      assert.equal(runtime.coordinator.apply(signal({ state, runId: null })).outcome, 'applied');
    } finally {
      fs.rmSync(runtime.root, { recursive: true, force: true });
    }
  }
}

function testRenameAndClearProjection(): void {
  const runtime = createRuntime();
  try {
    assert.equal(runtime.coordinator.apply(signal()).outcome, 'applied');
    runtime.setIdentity({ ...runtime.getIdentity()!, sessionName: 'repo_worker_renamed' });
    assert.equal(runtime.coordinator.apply(signal({ revision: 2, signalId: 'signal-renamed' })).outcome, 'applied');
    assert.equal(runtime.v1.get('repo_worker'), undefined);
    assert.equal(runtime.v1.get('repo_worker_renamed')?.state, 'running');

    runtime.setIdentity(undefined);
    assert.equal(runtime.coordinator.clear(7), true);
    assert.equal(runtime.v1.get('repo_worker_renamed'), undefined);
    assert.equal(runtime.v2.get(7), undefined);
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function testDuplicateRepairsFailedProjectionWithoutSecondEvent(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-runtime-v2-project-retry-'));
  try {
    const v2 = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    const compatibility = new FailingCompatibilityStore();
    compatibility.failNextProject = true;
    const eventPath = path.join(root, 'events.jsonl');
    const coordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === 7 ? {
        workerId: 7,
        sessionName: 'repo_worker',
        lifecycleEpoch: 'epoch-1',
      } : undefined,
      v2,
      compatibility,
      new EventLog(eventPath, path.join(root, 'events.state.json')),
    );

    const firstSignal = signal();
    assert.throws(() => coordinator.apply(firstSignal), /projection failure/);
    assert.equal(v2.get(7)?.state, 'running');
    assert.equal(compatibility.get('repo_worker'), undefined);
    assert.equal(readEventCount(eventPath), 1);

    assert.equal(coordinator.apply(firstSignal).outcome, 'duplicate');
    assert.equal(compatibility.get('repo_worker')?.state, 'running');
    assert.equal(readEventCount(eventPath), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testDuplicateRepairsFailedRenameClear(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-runtime-v2-clear-retry-'));
  try {
    const v2 = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    const compatibility = new FailingCompatibilityStore();
    const eventPath = path.join(root, 'events.jsonl');
    let sessionName = 'repo_worker';
    const coordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === 7 ? { workerId: 7, sessionName, lifecycleEpoch: 'epoch-1' } : undefined,
      v2,
      compatibility,
      new EventLog(eventPath, path.join(root, 'events.state.json')),
    );

    assert.equal(coordinator.apply(signal()).outcome, 'applied');
    sessionName = 'repo_worker_renamed';
    compatibility.failNextClearFor = 'repo_worker';
    const renameSignal = signal({ revision: 2, signalId: 'rename-signal' });
    assert.throws(() => coordinator.apply(renameSignal), /clear failure/);
    assert.equal(v2.get(7)?.sessionName, 'repo_worker_renamed');
    assert.equal(compatibility.get('repo_worker')?.state, 'running');
    assert.equal(compatibility.get('repo_worker_renamed'), undefined);
    assert.equal(readEventCount(eventPath), 2);

    assert.equal(coordinator.apply(renameSignal).outcome, 'duplicate');
    assert.equal(compatibility.get('repo_worker'), undefined);
    assert.equal(compatibility.get('repo_worker_renamed')?.state, 'running');
    assert.equal(readEventCount(eventPath), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testClearDrainsPendingRenameRoutesBeforeDeletingV2(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-runtime-v2-clear-pending-'));
  try {
    const v2 = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    const compatibility = new FailingCompatibilityStore();
    let sessionName = 'repo_worker';
    const coordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === 7 ? { workerId: 7, sessionName, lifecycleEpoch: 'epoch-1' } : undefined,
      v2,
      compatibility,
      new EventLog(path.join(root, 'events.jsonl'), path.join(root, 'events.state.json')),
    );

    assert.equal(coordinator.apply(signal()).outcome, 'applied');
    sessionName = 'repo_worker_renamed';
    compatibility.failNextClearFor = 'repo_worker';
    assert.throws(
      () => coordinator.apply(signal({ revision: 2, signalId: 'rename-before-clear' })),
      /clear failure/,
    );
    compatibility.project({
      sessionName: 'repo_worker_renamed',
      state: 'running',
      origin: 'manual',
      reason: 'test-current-route',
      workerId: 7,
    });
    assert.deepEqual(v2.getPendingCompatibilityClears(7), ['repo_worker']);

    assert.equal(coordinator.clear(7), true);
    assert.equal(compatibility.get('repo_worker'), undefined);
    assert.equal(compatibility.get('repo_worker_renamed'), undefined);
    assert.equal(v2.get(7), undefined);
    assert.deepEqual(v2.getPendingCompatibilityClears(7), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testClearRemovesRejectedFirstSignalMetadata(): void {
  const runtime = createRuntime('hydra-runtime-v2-clear-rejected-first-');
  try {
    const rejected = signal({
      state: 'needs-input',
      runId: 'run-1',
      signalId: 'rejected-first-question',
    });
    assert.equal(runtime.coordinator.apply(rejected).outcome, 'illegal-transition');
    assert.equal(runtime.v2.get(7), undefined);
    assert.equal(runtime.coordinator.clear(7), true);
    assert.deepEqual(runtime.v2.list(), []);
    assert.deepEqual(runtime.v2.getPendingCompatibilityClears(7), []);

    const persisted = JSON.parse(fs.readFileSync(runtime.v2Path, 'utf-8')) as {
      workers: Record<string, unknown>;
      processedSignalIds: Record<string, unknown>;
      pendingCompatibilityClears: Record<string, unknown>;
    };
    assert.deepEqual(persisted.workers, {});
    assert.deepEqual(persisted.processedSignalIds, {});
    assert.deepEqual(persisted.pendingCompatibilityClears, {});
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function testSpecificClearAcknowledgementPreservesConcurrentEntries(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-runtime-v2-clear-ack-'));
  try {
    const v2 = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    v2.update(store => {
      store.pendingCompatibilityClears['7'] = ['old-session'];
    });
    const observed = v2.getPendingCompatibilityClears(7);
    v2.update(store => {
      store.pendingCompatibilityClears['7'] = [...store.pendingCompatibilityClears['7'], 'new-session'];
    });
    v2.acknowledgeCompatibilityClears(7, observed);
    assert.deepEqual(v2.getPendingCompatibilityClears(7), ['new-session']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testTwoCoordinatorRenameInterleavingProjectsNewest(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-runtime-v2-rename-race-'));
  try {
    const v2 = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    const compatibility = new FailingCompatibilityStore();
    const eventPath = path.join(root, 'events.jsonl');
    const eventLog = new EventLog(eventPath, path.join(root, 'events.state.json'));
    let sessionName = 'repo_worker_a';
    const resolver = (workerId: number): WorkerRuntimeIdentity | undefined => workerId === 7
      ? { workerId: 7, sessionName, lifecycleEpoch: 'epoch-1' }
      : undefined;
    const coordinatorA = new WorkerRuntimeCoordinator(resolver, v2, compatibility, eventLog);
    const coordinatorB = new WorkerRuntimeCoordinator(resolver, v2, compatibility, eventLog);

    assert.equal(coordinatorA.apply(signal()).outcome, 'applied');
    sessionName = 'repo_worker_b';
    let nestedApplied = false;
    compatibility.onClear = clearedSessionName => {
      if (clearedSessionName !== 'repo_worker_a' || nestedApplied) return;
      nestedApplied = true;
      sessionName = 'repo_worker_c';
      compatibility.failNextClearFor = 'repo_worker_b';
      assert.throws(
        () => coordinatorB.apply(signal({ revision: 3, signalId: 'rename-c' })),
        /clear failure/,
      );
    };

    assert.equal(coordinatorA.apply(signal({ revision: 2, signalId: 'rename-b' })).outcome, 'applied');
    assert.equal(nestedApplied, true);
    assert.equal(v2.get(7)?.revision, 3);
    assert.equal(v2.get(7)?.sessionName, 'repo_worker_c');
    assert.equal(compatibility.get('repo_worker_a'), undefined);
    assert.equal(compatibility.get('repo_worker_b'), undefined);
    assert.equal(compatibility.get('repo_worker_c')?.state, 'running');
    assert.deepEqual(v2.getPendingCompatibilityClears(7), []);
    assert.equal(readEventCount(eventPath), 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testLegacyRejectedSignalReturnsAuthoritativeSnapshot(): void {
  const runtime = createRuntime();
  try {
    const first = applyLegacyWorkerRuntimeState({
      sessionName: 'repo_worker', state: 'running', origin: 'manual', reason: 'first', workerId: 7,
      lifecycleEpoch: 'epoch-1', runId: 'run-1', revision: 2, signalId: 'legacy-first',
    }, 'cli', runtime.v1, runtime.v2);
    assert.equal(first.changed, true);

    const rejected = applyLegacyWorkerRuntimeState({
      sessionName: 'repo_worker', state: 'error', origin: 'manual', reason: 'rejected', workerId: 7,
      lifecycleEpoch: 'epoch-1', runId: 'run-1', revision: 1, signalId: 'legacy-stale',
    }, 'cli', runtime.v1, runtime.v2);
    assert.equal(rejected.changed, false);
    assert.equal(rejected.snapshot.state, 'running');
    assert.equal(rejected.snapshot.reason, 'first');
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function testInvalidSignalsFailBeforeMutation(): void {
  const invalidSignals: Array<[string, WorkerRuntimeSignalV2]> = [
    ['zero workerId', signal({ workerId: 0 })],
    ['fractional workerId', signal({ workerId: 1.5 })],
    ['infinite workerId', signal({ workerId: Number.POSITIVE_INFINITY })],
    ['negative revision', signal({ revision: -1 })],
    ['fractional revision', signal({ revision: 1.5 })],
    ['nan revision', signal({ revision: Number.NaN })],
    ['negative sourceSequence', signal({ sourceSequence: -1 })],
    ['fractional sourceSequence', signal({ sourceSequence: 1.5 })],
    ['empty sessionName', signal({ sessionName: '' })],
    ['empty lifecycleEpoch', signal({ lifecycleEpoch: '' })],
    ['empty signalId', signal({ signalId: '' })],
    ['oversized signalId', signal({ signalId: 'x'.repeat(501) })],
    ['empty runId', signal({ runId: '' })],
    ['empty reason', signal({ reason: '' })],
    ['invalid timestamp', signal({ observedAt: 'not-a-time' })],
    ['invalid state', { ...signal(), state: 'complete' as WorkerRuntimeSignalV2['state'] }],
    ['invalid origin', { ...signal(), origin: 'notification' as WorkerRuntimeSignalV2['origin'] }],
  ];

  for (const [label, invalidSignal] of invalidSignals) {
    const runtime = createRuntime('hydra-runtime-v2-invalid-');
    try {
      assert.throws(() => runtime.coordinator.apply(invalidSignal), { message: /worker runtime/i }, label);
      assert.equal(fs.existsSync(runtime.v2Path), false, label);
    } finally {
      fs.rmSync(runtime.root, { recursive: true, force: true });
    }
  }
}

function testCorruptStoresFailClosed(): void {
  const runtime = createRuntime('hydra-runtime-v2-corrupt-');
  try {
    const malformed = '{"version":2,"workers":';
    fs.writeFileSync(runtime.v2Path, malformed, 'utf-8');
    assert.throws(() => runtime.v2.list(), /not valid JSON/);
    assert.throws(() => runtime.coordinator.apply(signal()), /not valid JSON/);
    assert.equal(fs.readFileSync(runtime.v2Path, 'utf-8'), malformed);

    const partialInvalid = JSON.stringify({
      version: 2,
      workers: {
        '7': { version: 2, ...signal() },
        '8': { version: 2, ...signal({ workerId: 8, signalId: '' }) },
      },
      processedSignalIds: { '7': { 'epoch-1': ['signal-1'] } },
      pendingCompatibilityClears: {},
    });
    fs.writeFileSync(runtime.v2Path, partialInvalid, 'utf-8');
    assert.throws(() => runtime.v2.list(), /signalId/);
    assert.throws(() => runtime.coordinator.apply(signal({ revision: 2, signalId: 'signal-2' })), /signalId/);
    assert.equal(fs.readFileSync(runtime.v2Path, 'utf-8'), partialInvalid);

    const unsupported = JSON.stringify({ version: 1, workers: {}, processedSignalIds: {}, pendingCompatibilityClears: {} });
    fs.writeFileSync(runtime.v2Path, unsupported, 'utf-8');
    assert.throws(() => runtime.v2.list(), /unsupported version or shape/);
    assert.equal(fs.readFileSync(runtime.v2Path, 'utf-8'), unsupported);
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

function main(): void {
  testOrderingEpochRunAndDedupe();
  testRejectedSignalNeverResurrectsAfterHistoryGrowth();
  testEpochFirstIdleAndError();
  testRenameAndClearProjection();
  testDuplicateRepairsFailedProjectionWithoutSecondEvent();
  testDuplicateRepairsFailedRenameClear();
  testClearDrainsPendingRenameRoutesBeforeDeletingV2();
  testClearRemovesRejectedFirstSignalMetadata();
  testSpecificClearAcknowledgementPreservesConcurrentEntries();
  testTwoCoordinatorRenameInterleavingProjectsNewest();
  testLegacyRejectedSignalReturnsAuthoritativeSnapshot();
  testInvalidSignalsFailBeforeMutation();
  testCorruptStoresFailClosed();
  console.log('workerRuntimeCoordinatorSmoke: ok');
}

function compatibilitySnapshot(input: SetWorkerRuntimeStateInput): WorkerRuntimeSnapshot {
  return {
    sessionName: input.sessionName,
    state: input.state,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    origin: input.origin,
    reason: input.reason,
    notificationId: input.notificationId,
    workerId: input.workerId,
    agent: input.agent,
    workdir: input.workdir,
  };
}

function readEventCount(eventPath: string): number {
  return fs.readFileSync(eventPath, 'utf-8').split(/\r?\n/).filter(line => line.trim()).length;
}

main();
