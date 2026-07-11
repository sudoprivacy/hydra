import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventHub } from '../core/eventHub';
import { EventLog, type HydraEvent } from '../core/events';
import { NotificationStore, type CreateNotificationInput, type HydraNotification } from '../core/notifications';
import {
  NotificationStoreV2,
  type HydraNotificationV2,
  type NotificationSignalReceiptV2,
} from '../core/notificationV2';

const SCALE = 100_000;
const EVENT_SEGMENT_SIZE = 10_000;
const HISTORY_LIMIT = 1_000;
const FIXED_TIME = '2026-07-11T00:00:00.000Z';

function event(seq: number): HydraEvent {
  return {
    version: 1,
    seq,
    bootId: 'wave-5-scale-test',
    ts: FIXED_TIME,
    type: 'wave5.scale',
    source: 'cli',
    payload: { index: seq },
  };
}

function writeEventRange(filePath: string, start: number, end: number): void {
  const lines = new Array<string>(end - start + 1);
  for (let seq = start; seq <= end; seq += 1) {
    lines[seq - start] = JSON.stringify(event(seq));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
}

async function testHundredThousandEventRetention(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-wave5-events-'));
  try {
    const eventsPath = path.join(root, 'events.jsonl');
    const statePath = path.join(root, 'events.state.json');
    for (let start = 1; start <= SCALE - EVENT_SEGMENT_SIZE; start += EVENT_SEGMENT_SIZE) {
      const end = start + EVENT_SEGMENT_SIZE - 1;
      writeEventRange(`${eventsPath}.${start}-${end}.segment`, start, end);
    }
    writeEventRange(eventsPath, SCALE - EVENT_SEGMENT_SIZE + 1, SCALE);
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 1, lastSeq: SCALE })}\n`, 'utf-8');

    const eventLog = new EventLog(eventsPath, statePath, {
      maxActiveBytes: 2 * 1024 * 1024,
      maxSegments: 16,
      maxSegmentAgeMs: 60_000,
    });
    const retained = eventLog.read();
    assert.equal(retained.length, SCALE);
    assert.equal(retained[0]?.seq, 1);
    assert.equal(retained.at(-1)?.seq, SCALE);
    assert.equal(new Set(retained.map(item => item.seq)).size, SCALE, 'retained event sequences must be unique');
    for (let index = 1; index < retained.length; index += 1) {
      assert.equal(retained[index]?.seq, retained[index - 1]!.seq + 1, 'retained events must remain ordered');
    }

    const cursorRead = eventLog.read({ after: SCALE - 10 });
    assert.deepEqual(cursorRead.map(item => item.seq), [
      SCALE - 9, SCALE - 8, SCALE - 7, SCALE - 6, SCALE - 5,
      SCALE - 4, SCALE - 3, SCALE - 2, SCALE - 1, SCALE,
    ]);

    const hub = new EventHub(eventLog, { pollIntervalMs: 10_000, maxHistoryEvents: SCALE });
    const replay = hub.subscribe(SCALE - 10);
    const replayed: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      replayed.push((await replay.next()).value!.seq);
    }
    assert.deepEqual(replayed, cursorRead.map(item => item.seq), 'EventHub replay must match cursor reads');
    assert.equal(new Set(replayed).size, replayed.length, 'EventHub replay must not duplicate sequences');

    const appended = eventLog.append({ type: 'wave5.after-scale', source: 'cli' });
    assert.equal(appended.seq, SCALE + 1);
    assert.equal((await replay.next()).value?.seq, SCALE + 1, 'EventHub must continue live fan-out after scale replay');
    await replay.return?.();
    hub.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function receiptFrom(notification: HydraNotificationV2): NotificationSignalReceiptV2 {
  return {
    id: notification.id,
    occurrenceId: notification.occurrenceId,
    workerId: notification.workerId,
    lifecycleEpoch: notification.lifecycleEpoch,
    runId: notification.runId,
    signalId: notification.signalId,
    kind: notification.kind,
    status: notification.status,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    resolvedAt: notification.resolvedAt,
    dismissedAt: notification.dismissedAt,
    sourceSession: notification.sourceSession,
    targetSession: notification.targetSession,
  };
}

function signalIdentity(notification: HydraNotificationV2): string {
  return JSON.stringify([
    notification.workerId,
    notification.lifecycleEpoch,
    notification.runId,
    notification.signalId,
  ]);
}

function scaledNotification(index: number): HydraNotificationV2 {
  const active = index === SCALE - 1;
  return {
    version: 2,
    id: active ? 'notification-active' : `notification-history-${index}`,
    occurrenceId: active ? 'occurrence-active' : `occurrence-history-${index}`,
    workerId: index + 1,
    lifecycleEpoch: `epoch-${index}`,
    runId: `run-${index}`,
    signalId: `signal-${index}`,
    kind: active ? 'needs-input' : 'complete',
    status: active ? 'active' : 'resolved',
    title: active ? 'Worker needs input' : 'Worker completed',
    body: '',
    createdAt: FIXED_TIME,
    readAt: null,
    resolvedAt: active ? null : FIXED_TIME,
    dismissedAt: null,
    sourceSession: active ? 'active-worker' : `worker-${index}`,
    targetSession: 'wave5-copilot',
  };
}

function writeInChunks(
  fd: number,
  count: number,
  serialize: (index: number) => string,
): void {
  const chunk: string[] = [];
  for (let index = 0; index < count; index += 1) {
    chunk.push(serialize(index));
    if (chunk.length === 1_000 || index === count - 1) {
      fs.writeSync(fd, chunk.join(','));
      chunk.length = 0;
      if (index < count - 1) fs.writeSync(fd, ',');
    }
  }
}

function seedNotificationScaleStore(filePath: string): void {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, '{"version":2,"notifications":[');
    writeInChunks(fd, SCALE, index => JSON.stringify(scaledNotification(index)));
    fs.writeSync(fd, '],"tombstones":[],"signalReceipts":{');
    writeInChunks(fd, SCALE, index => {
      const notification = scaledNotification(index);
      return `${JSON.stringify(signalIdentity(notification))}:${JSON.stringify(receiptFrom(notification))}`;
    });
    fs.writeSync(fd, '},"pendingCompatibility":{}}\n');
  } finally {
    fs.closeSync(fd);
  }
}

function testHundredThousandNotificationRetention(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-wave5-notifications-'));
  try {
    const filePath = path.join(root, 'notifications-v2.json');
    seedNotificationScaleStore(filePath);

    const now = Date.parse(FIXED_TIME) + 1;
    const store = new NotificationStoreV2(filePath, HISTORY_LIMIT, 60_000, () => now);
    const mutation = store.markRead('notification-active', new Date(now).toISOString());
    assert.equal(mutation.changed, true);
    assert.equal(mutation.notification.status, 'active');

    const snapshot = store.snapshot();
    assert.equal(snapshot.notifications.length, HISTORY_LIMIT + 1);
    assert.equal(snapshot.notifications.filter(item => item.status === 'active').length, 1);
    assert.equal(snapshot.notifications.filter(item => item.status !== 'active').length, HISTORY_LIMIT);
    assert.equal(snapshot.notifications.find(item => item.id === 'notification-active')?.readAt, new Date(now).toISOString());
    assert.equal(
      Object.keys(snapshot.signalReceipts).length,
      SCALE,
      'history pruning must retain all signal receipts for durable idempotency',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function workerNotification(
  kind: CreateNotificationInput['kind'],
  signal: string,
): CreateNotificationInput {
  return {
    kind,
    title: `Wave 5 ${kind}`,
    body: `Signal ${signal}`,
    sourceSession: 'worker-before-rename',
    targetSession: 'wave5-copilot',
    dedupeKey: `${kind}:${signal}`,
    lifecycleEpoch: 'epoch-wave5',
    runId: `run-${signal}`,
    signalId: signal,
    action: { type: 'open-session', session: 'worker-before-rename' },
    context: { workerId: 7, branch: 'feat/wave5', agent: 'codex' },
  };
}

function readLegacy(filePath: string): HydraNotification[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
    version: number;
    notifications: HydraNotification[];
  };
  assert.equal(parsed.version, 1);
  return parsed.notifications;
}

function comparableV1(notification: HydraNotification): object {
  return {
    id: notification.id,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    sourceSession: notification.sourceSession,
    targetSession: notification.targetSession,
    action: notification.action,
    workerId: notification.context?.workerId,
  };
}

function comparableV2(notification: HydraNotificationV2): object {
  return {
    id: notification.id,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    sourceSession: notification.sourceSession,
    targetSession: notification.targetSession,
    action: notification.action,
    workerId: notification.workerId,
  };
}

function assertShadowEquivalent(
  facade: NotificationStore,
  v1Path: string,
  v2: NotificationStoreV2,
): void {
  const legacy = readLegacy(v1Path).sort((a, b) => a.id.localeCompare(b.id));
  const activeV2 = v2.list('active').sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(legacy.map(comparableV1), activeV2.map(comparableV2));
  assert.deepEqual(
    facade.list().notifications.map(comparableV1).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    activeV2.map(comparableV2).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

function testV1V2ShadowLifecycle(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-wave5-shadow-'));
  try {
    const v1Path = path.join(root, 'notifications.json');
    const v2Path = path.join(root, 'notifications-v2.json');
    const eventsPath = path.join(root, 'events.jsonl');
    const statePath = path.join(root, 'events.state.json');
    const eventLog = new EventLog(eventsPath, statePath);
    let now = Date.parse(FIXED_TIME);
    let v2 = new NotificationStoreV2(v2Path, HISTORY_LIMIT, 60_000, () => now);
    let facade = new NotificationStore(v1Path, HISTORY_LIMIT, eventLog, undefined, () => now, v2);

    const complete = facade.create(workerNotification('complete', 'complete-1')).notification;
    now += 1;
    const needsInput = facade.create(workerNotification('needs-input', 'question-1')).notification;
    now += 1;
    const blocked = facade.create(workerNotification('blocked', 'blocked-1')).notification;
    assertShadowEquivalent(facade, v1Path, v2);

    now += 1;
    assert.equal(facade.markRead(needsInput.id, 'extension').markedRead, 1);
    assertShadowEquivalent(facade, v1Path, v2);

    now += 1;
    assert.equal(facade.resolve(needsInput.id, 'worker answered').status, 'resolved');
    assertShadowEquivalent(facade, v1Path, v2);

    now += 1;
    assert.equal(facade.dismiss(blocked.id, 'cli').status, 'dismissed');
    assertShadowEquivalent(facade, v1Path, v2);

    v2 = new NotificationStoreV2(v2Path, HISTORY_LIMIT, 60_000, () => now);
    facade = new NotificationStore(v1Path, HISTORY_LIMIT, eventLog, undefined, () => now, v2);
    assertShadowEquivalent(facade, v1Path, v2);

    assert.equal(facade.clear({ sourceSession: 'worker-before-rename', kind: 'complete' }).cleared, 1);
    assert.equal(facade.list().totalCount, 0);
    assert.equal(v2.list('active').length, 0);
    assert.equal(readLegacy(v1Path).length, 0);
    assert.equal(v2.get(complete.id)?.status, 'dismissed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testHundredThousandEventRetention();
  testHundredThousandNotificationRetention();
  testV1V2ShadowLifecycle();
  console.log('wave5MigrationSmoke: ok');
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
