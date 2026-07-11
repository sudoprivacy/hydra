/**
 * Focused Desktop v2 protocol smoke.
 *
 * Proves the additive runtime/notification v2 surface without changing the
 * frozen CLI-shaped operations:
 *   - runtime snapshot cursor is captured before the store read;
 *   - notification occurrence filtering and un-limited counts;
 *   - initial and live occurrence snapshots;
 *   - create/read/dismiss updates and prompt iterator cancellation;
 *   - legacy and v2 subscribers share one watcher without stopping each other.
 *
 * Run: node packages/sidecar/out/smoke/desktopV2ProtocolSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient, transportFactory } from '@hydra/protocol';
import type {
  HydraEvent,
  NotificationOccurrenceSnapshotV2,
  NotificationSnapshot,
  WorkerRuntimeSnapshotV2,
} from '@hydra/protocol';
import { FakeBackend } from './fakeBackend';

const STREAM_TIMEOUT_MS = 2_000;

async function nextWithin<T>(
  iterator: AsyncIterator<T>,
  label: string,
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          STREAM_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closePromptly<T>(
  iterator: AsyncIterator<T>,
  pending: Promise<IteratorResult<T>>,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  await iterator.return?.();
  assert.ok(Date.now() - startedAt < 100, `${label} cancels promptly`);
  assert.equal((await pending).done, true, `${label} releases pending next()`);
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-desktop-v2-protocol-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  const hydraHome = process.env.HYDRA_HOME;
  fs.mkdirSync(hydraHome, { recursive: true });

  // Import after HYDRA_HOME is isolated so every default path stays in tempHome.
  const { EventLog } = await import('@hydra/core/events');
  const { NotificationStore } = await import('@hydra/core/notifications');
  const { WorkerRuntimeStateStore } = await import('@hydra/core/workerRuntimeState');
  const { WorkerRuntimeStateStoreV2 } = await import('@hydra/core/workerRuntimeV2');
  const { HydraAppService } = await import('../appService');

  const eventLog = new EventLog(
    path.join(hydraHome, 'events.jsonl'),
    path.join(hydraHome, 'events.state.json'),
  );
  const runtimeSnapshot: WorkerRuntimeSnapshotV2 = {
    version: 2,
    workerId: 7,
    sessionName: 'worker-seven',
    lifecycleEpoch: 'epoch-seven',
    runId: 'run-seven',
    revision: 3,
    state: 'running',
    signalId: 'signal-seven',
    origin: 'lifecycle',
    reason: 'desktop-v2-smoke',
    observedAt: '2026-07-11T00:00:00.000Z',
    agent: 'codex',
    workdir: tempHome,
  };

  class CursorRaceRuntimeStore extends WorkerRuntimeStateStoreV2 {
    private appendedDuringList = false;

    override list(): WorkerRuntimeSnapshotV2[] {
      const runtimes = super.list();
      if (!this.appendedDuringList) {
        this.appendedDuringList = true;
        eventLog.append({
          type: 'worker.runtime.changed',
          source: 'session-manager',
          session: runtimeSnapshot.sessionName,
          role: 'worker',
          payload: { ...runtimeSnapshot },
        });
      }
      return runtimes;
    }
  }

  const runtimeStore = new CursorRaceRuntimeStore(path.join(hydraHome, 'worker-runtime-state-v2.json'));
  runtimeStore.update(store => {
    store.workers[String(runtimeSnapshot.workerId)] = { ...runtimeSnapshot };
  });
  const compatibilityStore = new WorkerRuntimeStateStore(
    path.join(hydraHome, 'worker-runtime-state.json'),
    eventLog,
  );
  let nowMs = Date.parse('2026-07-11T01:00:00.000Z');
  const notificationStore = new NotificationStore(
    path.join(hydraHome, 'notifications.json'),
    undefined,
    eventLog,
    compatibilityStore,
    () => nowMs++,
    undefined,
    runtimeStore,
  );

  const baselineEvent = eventLog.append({
    type: 'desktop.v2.snapshot.baseline',
    source: 'session-manager',
  });
  const appService = new HydraAppService({
    backend: new FakeBackend(),
    eventLog,
    notificationStore,
    runtimeStateStore: compatibilityStore,
    runtimeV2Store: runtimeStore,
  });
  const client = createHydraControlClient(transportFactory({ kind: 'in-process', appService }));

  try {
    // The store appends a runtime event during list(). The returned cursor must
    // remain at the pre-read baseline so subscribing after it replays the race.
    const runtime = await client.listWorkerRuntimeV2();
    assert.equal(runtime.version, 2);
    assert.equal(runtime.count, 1);
    assert.deepEqual(runtime.runtimes, [runtimeSnapshot]);
    assert.equal(runtime.lastEventSeq, baselineEvent.seq, 'runtime cursor is captured before store.list()');
    assert.ok(Number.isFinite(Date.parse(runtime.loadedAt)), 'runtime snapshot has a valid loadedAt');

    const runtimeEvents = client.subscribeEvents({ after: runtime.lastEventSeq })[Symbol.asyncIterator]();
    const racedRuntimeEvent = await nextWithin<HydraEvent>(runtimeEvents, 'raced runtime event');
    assert.equal(racedRuntimeEvent.done, false);
    assert.equal(racedRuntimeEvent.value?.type, 'worker.runtime.changed');
    assert.equal(racedRuntimeEvent.value?.session, runtimeSnapshot.sessionName);
    await runtimeEvents.return?.();

    const alpha = notificationStore.create({
      kind: 'needs-input',
      title: 'Alpha needs input',
      body: 'Choose a platform behavior.',
      sourceSession: 'worker-alpha',
      targetSession: 'copilot-a',
      context: { workerId: 1 },
      lifecycleEpoch: 'epoch-alpha',
      runId: 'run-alpha',
      signalId: 'signal-alpha',
    }).occurrence;
    const beta = notificationStore.create({
      kind: 'complete',
      title: 'Beta complete',
      sourceSession: 'worker-beta',
      targetSession: null,
      context: { workerId: 2 },
      lifecycleEpoch: 'epoch-beta',
      runId: 'run-beta',
      signalId: 'signal-beta',
    }).occurrence;
    assert.ok(alpha && beta, 'seed notifications are promoted to v2 occurrences');

    const limited = await client.listNotificationOccurrencesV2({ status: 'active', limit: 1 });
    assert.equal(limited.version, 2);
    assert.equal(limited.count, 1, 'limit controls returned occurrences');
    assert.equal(limited.totalCount, 2, 'totalCount is computed before limit');
    assert.equal(limited.activeCount, 2, 'activeCount is computed before limit');
    assert.equal(limited.unreadCount, 2, 'unreadCount is computed before limit');
    assert.equal(limited.occurrences[0].id, beta.id, 'occurrences remain newest-first');

    const routed = await client.listNotificationOccurrencesV2({ session: 'copilot-a' });
    assert.deepEqual(routed.occurrences.map(item => item.id), [alpha.id], 'session matches target route');
    const byWorkerAndKind = await client.listNotificationOccurrencesV2({
      workerId: 1,
      sourceSession: 'worker-alpha',
      kind: 'needs-input',
      status: 'active',
    });
    assert.deepEqual(byWorkerAndKind.occurrences.map(item => item.id), [alpha.id]);

    await assert.rejects(
      () => client.listNotificationOccurrencesV2({ workerId: 0 }),
      /workerId must be a positive safe integer/,
    );
    await assert.rejects(
      () => client.listNotificationOccurrencesV2({ limit: 1001 }),
      /limit must be a positive safe integer/,
    );
    await assert.rejects(
      () => client.listNotificationOccurrencesV2({ kind: 'unknown' as never }),
      /unsupported notification kind/,
    );
    await assert.rejects(
      () => client.listNotificationOccurrencesV2({ session: 'x'.repeat(201) }),
      /session must be a non-empty string of at most 200 characters/,
    );

    const initialStream = client.subscribeNotificationOccurrencesV2({
      workerId: 1,
      status: 'active',
    })[Symbol.asyncIterator]();
    const initial = await nextWithin<NotificationOccurrenceSnapshotV2>(initialStream, 'initial occurrence snapshot');
    assert.equal(initial.done, false);
    assert.deepEqual(initial.value?.occurrences.map(item => item.id), [alpha.id]);
    assert.equal(initial.value?.totalCount, 1);
    assert.ok(Number.isFinite(Date.parse(initial.value?.loadedAt ?? '')), 'occurrence snapshot has loadedAt');
    assert.ok((initial.value?.lastEventSeq ?? 0) >= baselineEvent.seq, 'occurrence snapshot has an event cursor');
    await initialStream.return?.();

    // A legacy subscriber may leave while a v2 subscriber remains. The shared
    // watcher must stay alive and publish an external create plus client-side
    // read/dismiss transitions to the v2 subscriber.
    const legacy = client.subscribeNotifications()[Symbol.asyncIterator]();
    await nextWithin<NotificationSnapshot>(legacy, 'legacy initial snapshot');
    const live = client.subscribeNotificationOccurrencesV2({
      workerId: 3,
      status: 'active',
    })[Symbol.asyncIterator]();
    const liveInitial = await nextWithin<NotificationOccurrenceSnapshotV2>(live, 'live initial snapshot');
    assert.equal(liveInitial.value?.totalCount, 0);
    await legacy.return?.();

    const gamma = notificationStore.create({
      kind: 'error',
      title: 'Gamma failed',
      body: 'Retry the worker.',
      sourceSession: 'worker-gamma',
      targetSession: null,
      context: { workerId: 3 },
      lifecycleEpoch: 'epoch-gamma',
      runId: 'run-gamma',
      signalId: 'signal-gamma',
    }).occurrence;
    assert.ok(gamma);
    const created = await nextWithin<NotificationOccurrenceSnapshotV2>(live, 'live occurrence create');
    assert.deepEqual(
      created.value?.occurrences.map(
        (item: NotificationOccurrenceSnapshotV2['occurrences'][number]) => item.id,
      ),
      [gamma.id],
    );
    assert.equal(created.value?.unreadCount, 1);

    const read = await client.markNotificationRead(gamma.id);
    assert.equal(read.markedRead, 1);
    const readSnapshot = await nextWithin<NotificationOccurrenceSnapshotV2>(live, 'live occurrence read');
    assert.ok(readSnapshot.value?.occurrences[0].readAt, 'read transition is pushed with full occurrence content');
    assert.equal(readSnapshot.value?.unreadCount, 0);

    const dismissed = await client.dismissNotification(gamma.id);
    assert.equal(dismissed.status, 'dismissed');
    const dismissedSnapshot = await nextWithin<NotificationOccurrenceSnapshotV2>(live, 'live occurrence dismiss');
    assert.equal(dismissedSnapshot.value?.totalCount, 0, 'active stream removes dismissed occurrence');

    const pendingLive = live.next();
    await closePromptly(live, pendingLive, 'v2 notification stream');

    // The inverse ownership case: cancelling the only v2 subscriber must not
    // stop a remaining legacy subscriber.
    const legacyOnly = client.subscribeNotifications()[Symbol.asyncIterator]();
    await nextWithin<NotificationSnapshot>(legacyOnly, 'legacy-only initial snapshot');
    const temporaryV2 = client.subscribeNotificationOccurrencesV2({ workerId: 4 })[Symbol.asyncIterator]();
    await nextWithin<NotificationOccurrenceSnapshotV2>(temporaryV2, 'temporary v2 initial snapshot');
    await temporaryV2.return?.();

    const pendingLegacy = legacyOnly.next();
    const delta = notificationStore.create({
      kind: 'blocked',
      title: 'Delta blocked',
      sourceSession: 'worker-delta',
      targetSession: null,
      context: { workerId: 4 },
      lifecycleEpoch: 'epoch-delta',
      runId: 'run-delta',
      signalId: 'signal-delta',
    }).notification;
    const legacyChanged = await nextWithin<NotificationSnapshot>(
      { next: () => pendingLegacy },
      'legacy update after v2 cancellation',
    );
    assert.ok(
      legacyChanged.value?.notifications.some(
        (item: NotificationSnapshot['notifications'][number]) => item.id === delta.id,
      ),
      'legacy stream remains live after the v2 stream leaves',
    );
    const pendingLegacyClose = legacyOnly.next();
    await closePromptly(legacyOnly, pendingLegacyClose, 'legacy notification stream');

    assert.throws(
      () => client.subscribeNotificationOccurrencesV2({ limit: 0 }),
      /limit must be a positive safe integer/,
      'stream filters fail closed before a watcher is allocated',
    );

    console.log('desktopV2ProtocolSmoke: ok');
  } finally {
    appService.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
