import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventLog } from '../core/events';
import { NotificationStateService } from '../core/notificationStateService';
import { NotificationStore, type CreateNotificationInput } from '../core/notifications';
import {
  NotificationStoreV2,
  type CreateNotificationV2Input,
} from '../core/notificationV2';
import { WorkerRuntimeStateStoreV2 } from '../core/workerRuntimeV2';

function occurrence(overrides: Partial<CreateNotificationV2Input> = {}): CreateNotificationV2Input {
  return {
    id: 'notification-1',
    occurrenceId: 'occurrence-1',
    workerId: 7,
    lifecycleEpoch: 'epoch-1',
    runId: 'run-1',
    signalId: 'signal-1',
    kind: 'needs-input',
    title: 'Worker needs input',
    body: 'Choose a branch',
    createdAt: '2026-07-10T00:00:00.000Z',
    sourceSession: 'repo_worker',
    targetSession: 'repo_copilot',
    action: { type: 'open-session', session: 'repo_worker' },
    ...overrides,
  };
}

function testOccurrenceLifecycleDedupeAndRetention(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-lifecycle-'));
  try {
    const filePath = path.join(root, 'notifications-v2.json');
    let nowMs = Date.parse('2026-07-10T00:00:00.000Z');
    const store = new NotificationStoreV2(filePath, 2, 60_000, () => nowMs);

    const first = store.create(occurrence());
    assert.equal(first.created, true);
    assert.equal(first.notification.status, 'active');
    assert.equal(store.create(occurrence()).created, false);

    const laterRun = store.create(occurrence({
      id: 'notification-2', occurrenceId: 'occurrence-2', runId: 'run-2',
    }));
    assert.equal(laterRun.created, true, 'the same signal id in a later run must create a new occurrence');

    const read = store.markRead(first.notification.id, '2026-07-10T00:00:01.000Z');
    assert.equal(read.changed, true);
    assert.equal(read.notification.status, 'active');
    assert.equal(store.markRead(first.notification.id).changed, false);

    const resolved = store.resolve(first.notification.id, 'worker-answered', '2026-07-10T00:00:02.000Z');
    assert.equal(resolved.changed, true);
    assert.equal(resolved.notification.status, 'resolved');
    assert.equal(resolved.notification.resolvedAt, '2026-07-10T00:00:02.000Z');
    assert.equal(store.resolve(first.notification.id, 'duplicate').changed, false);

    const dismissed = store.dismiss(laterRun.notification.id, '2026-07-10T00:00:03.000Z');
    assert.equal(dismissed.changed, true);
    assert.equal(dismissed.notification.status, 'dismissed');

    for (let index = 3; index <= 7; index += 1) {
      store.create(occurrence({
        id: `notification-${index}`,
        occurrenceId: `occurrence-${index}`,
        runId: `run-${index}`,
        signalId: `signal-${index}`,
        createdAt: `2026-07-10T00:00:0${index}.000Z`,
      }));
    }
    assert.equal(store.list('active').length, 5, 'active occurrences must not obey the history count limit');
    assert.ok(store.list().filter(item => item.status !== 'active').length <= 2);

    const emptyClear = store.clear({ sourceSession: 'missing-worker' }, 41, '2026-07-10T00:00:08.000Z');
    assert.equal(emptyClear.cleared, 0);
    assert.equal(emptyClear.tombstone.throughEventSequence, 41);
    assert.equal(store.listTombstones().length, 1, 'zero-match clear must still persist a tombstone');

    const clear = store.clear({ sourceSession: 'repo_worker', kind: 'needs-input' }, 42, '2026-07-10T00:00:09.000Z');
    assert.equal(clear.cleared, 6, 'clear dismisses matching active and resolved occurrences');
    assert.equal(store.list('active').length, 0);
    assert.equal(store.listTombstones().length, 2);

    const replay = store.create(occurrence({
      id: 'replayed-id', occurrenceId: 'replayed-occurrence', runId: 'run-7', signalId: 'signal-7',
    }));
    assert.equal(replay.created, false);
    assert.equal(replay.notification.status, 'dismissed', 'dedupe replay must not reactivate a dismissed occurrence');

    nowMs += 120_000;
    store.create(occurrence({
      id: 'notification-new', occurrenceId: 'occurrence-new', runId: 'run-new', signalId: 'signal-new',
      createdAt: new Date(nowMs).toISOString(),
    }));
    assert.equal(store.list('active').length, 1);
    assert.equal(store.list().filter(item => item.status !== 'active').length, 0, 'aged history should be pruned');
    const agedReplay = store.create(occurrence({
      id: 'aged-replay-id', occurrenceId: 'aged-replay-occurrence', runId: 'run-7', signalId: 'signal-7',
    }));
    assert.equal(agedReplay.created, false, 'history retention must not erase signal idempotency');
    assert.equal(agedReplay.notification.status, 'dismissed');
    assert.equal(store.list('active').length, 1);
    assert.throws(
      () => store.create(occurrence({
        id: 'notification-1', occurrenceId: 'fresh-occurrence', runId: 'fresh-run', signalId: 'fresh-signal',
      })),
      /already used by a retained signal receipt/,
    );
    assert.equal(store.listTombstones().length, 2, 'tombstones remain until event segments can expire');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFacadeProjectionTombstoneAndRestart(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-facade-'));
  try {
    const v1Path = path.join(root, 'notifications.json');
    const v2Path = path.join(root, 'notifications-v2.json');
    const eventsPath = path.join(root, 'events.jsonl');
    const eventStatePath = path.join(root, 'events.state.json');
    const eventLog = new EventLog(eventsPath, eventStatePath);
    const v2 = new NotificationStoreV2(v2Path);
    const store = new NotificationStore(v1Path, 1, eventLog, undefined, Date.now, v2);
    const completeInput: CreateNotificationInput = {
      kind: 'complete',
      title: 'Worker completed',
      targetSession: 'repo_copilot',
      sourceSession: 'repo_worker',
      dedupeKey: 'complete:repo_worker:run-1',
      lifecycleEpoch: 'epoch-1',
      runId: 'run-1',
      signalId: 'complete-signal-1',
      context: { workerId: 7, branch: 'feat/example', agent: 'codex' },
      eventSource: 'hook',
    };

    const complete = store.create(completeInput).notification;
    store.create({
      kind: 'info', title: 'Compatibility record', sourceSession: 'other-worker', eventSource: 'cli',
    });
    const rawV1 = JSON.parse(fs.readFileSync(v1Path, 'utf-8')) as { notifications: Array<{ id: string }> };
    assert.equal(rawV1.notifications.length, 1);
    assert.notEqual(rawV1.notifications[0].id, complete.id, 'v1 retention may evict the active occurrence projection');
    assert.equal(store.list().totalCount, 2, 'v2 active occurrence must remain queryable after v1 eviction');

    assert.equal(store.markRead(complete.id, 'extension').markedRead, 1, 'read must work when the v1 projection was evicted');
    assert.equal(store.markRead(complete.id, 'extension').markedRead, 0);

    const options = {
      notificationsFile: v1Path,
      eventsFile: eventsPath,
      store,
      eventLog,
      debounceMs: 0,
      pollIntervalMs: 50,
    };
    const service = new NotificationStateService(options);
    service.initialize();
    assert.equal(service.getLatestSourceCompletion('repo_worker')?.id, complete.id);
    const cleared = service.clear({ sourceSession: 'repo_worker', kind: 'complete' }, 'cli');
    assert.equal(cleared.cleared, 1);
    assert.ok(cleared.tombstoneId);
    assert.equal(service.getLatestSourceCompletion('repo_worker'), undefined);
    service.dispose();

    const restarted = new NotificationStateService(options);
    restarted.initialize();
    assert.equal(restarted.getLatestSourceCompletion('repo_worker'), undefined);
    restarted.dispose();

    const replay = store.create(completeInput);
    assert.equal(replay.created, false);
    assert.equal(store.list({ sourceSession: 'repo_worker', kind: 'complete' }).count, 0);

    const zeroClear = store.clear({ sourceSession: 'never-seen' }, 'cli');
    assert.equal(zeroClear.cleared, 0);
    assert.ok(zeroClear.tombstoneId);
    assert.equal(v2.listTombstones().length, 2);

    const events = eventLog.read();
    const clearEvents = events.filter(event => event.type === 'notify.cleared');
    assert.equal(clearEvents.length, 2);
    assert.ok(clearEvents.every(event => typeof event.payload?.tombstoneId === 'string'));
    assert.ok(clearEvents.every(event => Number.isSafeInteger(event.payload?.throughEventSequence)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFacadeDedupeIsScopedByRun(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-run-dedupe-'));
  try {
    const eventLog = new EventLog(path.join(root, 'events.jsonl'), path.join(root, 'events.state.json'));
    const store = new NotificationStore(path.join(root, 'notifications.json'), 1000, eventLog);
    const base: CreateNotificationInput = {
      kind: 'needs-input',
      title: 'Choose a branch',
      sourceSession: 'repo_worker',
      targetSession: 'repo_copilot',
      dedupeKey: 'same-native-question',
      lifecycleEpoch: 'epoch-1',
      signalId: 'question-signal',
      context: { workerId: 7 },
    };

    const first = store.create({ ...base, runId: 'run-1' });
    const replay = store.create({ ...base, runId: 'run-1' });
    const laterRun = store.create({ ...base, runId: 'run-2' });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.notification.id, first.notification.id);
    assert.equal(laterRun.created, true);
    assert.notEqual(laterRun.notification.id, first.notification.id);
    assert.equal(store.list({ sourceSession: 'repo_worker', kind: 'needs-input' }).count, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFacadeUsesCurrentRuntimeIdentity(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-runtime-identity-'));
  try {
    const eventLog = new EventLog(path.join(root, 'events.jsonl'), path.join(root, 'events.state.json'));
    const runtime = new WorkerRuntimeStateStoreV2(path.join(root, 'worker-runtime-state-v2.json'));
    const setRun = (runId: string, revision: number): void => {
      runtime.update(store => {
        store.workers['7'] = {
          version: 2,
          workerId: 7,
          sessionName: 'repo_worker',
          lifecycleEpoch: 'epoch-runtime',
          runId,
          revision,
          state: 'running',
          signalId: `runtime-${runId}`,
          origin: 'lifecycle',
          reason: 'test-run',
          observedAt: `2026-07-10T00:00:0${revision}.000Z`,
        };
      });
    };
    setRun('run-runtime-1', 1);
    const facade = new NotificationStore(
      path.join(root, 'notifications.json'),
      1000,
      eventLog,
      undefined,
      Date.now,
      new NotificationStoreV2(path.join(root, 'notifications-v2.json')),
      runtime,
    );
    const input: CreateNotificationInput = {
      kind: 'needs-input', title: 'Same question', sourceSession: 'repo_worker', targetSession: 'repo_copilot',
      dedupeKey: 'same-question-fingerprint', context: { workerId: 7 },
    };
    const first = facade.create(input);
    assert.equal(first.created, true);
    assert.equal(facade.create(input).created, false);

    setRun('run-runtime-2', 2);
    const second = facade.create(input);
    assert.equal(second.created, true, 'runtime run identity must scope otherwise identical notification signals');
    assert.notEqual(second.notification.id, first.notification.id);
    assert.deepEqual(
      facade.listOccurrences('active').map(item => item.runId).sort(),
      ['run-runtime-1', 'run-runtime-2'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFacadeStatusAndCompatibilityRecovery(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-recovery-'));
  try {
    const v1Path = path.join(root, 'notifications.json');
    const v2Path = path.join(root, 'notifications-v2.json');
    const eventLog = new EventLog(path.join(root, 'events.jsonl'), path.join(root, 'events.state.json'));
    const v2 = new NotificationStoreV2(v2Path);
    const direct = v2.create(occurrence());
    assert.equal(v2.getPendingCompatibility()[direct.notification.id], 'upsert');

    const facade = new NotificationStore(v1Path, 1, eventLog, undefined, Date.now, v2);
    const replay = facade.create({
      kind: 'needs-input',
      title: 'Worker needs input',
      body: 'Choose a branch',
      sourceSession: 'repo_worker',
      targetSession: 'repo_copilot',
      lifecycleEpoch: 'epoch-1',
      runId: 'run-1',
      signalId: 'signal-1',
      context: { workerId: 7 },
    });
    assert.equal(replay.created, false);
    assert.equal(replay.notification.id, direct.notification.id);
    assert.deepEqual(v2.getPendingCompatibility(), {}, 'retry must repair and acknowledge a missing v1 upsert');

    facade.create({ kind: 'info', title: 'Evict v1 projection', sourceSession: 'other-worker' });
    const rawAfterEviction = JSON.parse(fs.readFileSync(v1Path, 'utf-8')) as { notifications: Array<{ id: string }> };
    assert.equal(rawAfterEviction.notifications.length, 1);
    assert.notEqual(rawAfterEviction.notifications[0].id, direct.notification.id);

    v2.markRead(direct.notification.id, '2026-07-10T00:00:05.000Z');
    assert.equal(v2.getPendingCompatibility()[direct.notification.id], 'update-if-present');
    facade.create({ kind: 'info', title: 'Trigger compatibility repair', sourceSession: 'third-worker' });
    const rawAfterReadRepair = JSON.parse(fs.readFileSync(v1Path, 'utf-8')) as { notifications: Array<{ id: string }> };
    assert.equal(rawAfterReadRepair.notifications.length, 1);
    assert.notEqual(
      rawAfterReadRepair.notifications[0].id,
      direct.notification.id,
      'update-if-present recovery must not resurrect a retention-evicted projection',
    );
    assert.deepEqual(v2.getPendingCompatibility(), {});

    const resolved = facade.resolve(direct.notification.id, 'worker-answered');
    assert.equal(resolved.changed, true);
    assert.equal(resolved.status, 'resolved');
    assert.equal(facade.list({ sourceSession: 'repo_worker' }).count, 0);

    const supersededInput: CreateNotificationInput = {
      kind: 'error', title: 'Transient error', sourceSession: 'repo_worker', targetSession: 'repo_copilot',
      lifecycleEpoch: 'epoch-1', runId: 'run-2', signalId: 'error-signal', context: { workerId: 7 },
    };
    const error = facade.create(supersededInput).notification;
    const superseded = facade.supersede(error.id, 'newer error occurrence');
    assert.equal(superseded.status, 'superseded');

    const dismissInput: CreateNotificationInput = {
      ...supersededInput, runId: 'run-3', signalId: 'error-signal-3', title: 'Dismissible error',
    };
    const dismissible = facade.create(dismissInput).notification;
    const dismissed = facade.dismiss(dismissible.id);
    assert.equal(dismissed.status, 'dismissed');

    const eventTypes = eventLog.read().map(event => event.type);
    assert.ok(eventTypes.includes('notify.resolved'));
    assert.ok(eventTypes.includes('notify.superseded'));
    assert.ok(eventTypes.includes('notify.dismissed'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCorruptStoreFailsClosed(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notification-v2-corrupt-'));
  try {
    const filePath = path.join(root, 'notifications-v2.json');
    const malformed = '{"version":2,"notifications":';
    fs.writeFileSync(filePath, malformed, 'utf-8');
    const store = new NotificationStoreV2(filePath);
    assert.throws(() => store.list(), /not valid JSON/);
    assert.throws(() => store.create(occurrence()), /not valid JSON/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), malformed);

    const invalid = JSON.stringify({
      version: 2,
      notifications: [{ version: 2, ...occurrence(), workerId: 0, status: 'active', readAt: null, resolvedAt: null, dismissedAt: null }],
      tombstones: [],
      signalReceipts: {},
      pendingCompatibility: {},
    });
    fs.writeFileSync(filePath, invalid, 'utf-8');
    assert.throws(() => store.list(), /workerId/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), invalid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  testOccurrenceLifecycleDedupeAndRetention();
  testFacadeProjectionTombstoneAndRestart();
  testFacadeDedupeIsScopedByRun();
  testFacadeUsesCurrentRuntimeIdentity();
  testFacadeStatusAndCompatibilityRecovery();
  testCorruptStoreFailsClosed();
  console.log('notificationV2Smoke: ok');
}

main();
