import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventHub } from '../core/eventHub';
import { EventLog, type EventReadOptions, type HydraEvent } from '../core/events';

class CountingEventLog extends EventLog {
  readCalls = 0;

  override read(options: EventReadOptions = {}): HydraEvent[] {
    this.readCalls += 1;
    return super.read(options);
  }
}

function append(log: EventLog, type: string): HydraEvent {
  return log.append({ type, source: 'session-manager' });
}

async function expectNoEvent(iterator: AsyncIterableIterator<HydraEvent>, waitMs: number): Promise<void> {
  const pending = iterator.next();
  const outcome = await Promise.race([
    pending.then(result => ({ kind: 'event' as const, result })),
    new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), waitMs)),
  ]);
  assert.equal(outcome.kind, 'timeout', 'dedupe must not emit an event twice');
  const started = Date.now();
  await iterator.return?.();
  assert.ok(Date.now() - started < 50, 'return must not wait for the poll interval');
  assert.equal((await pending).done, true, 'return must release an already pending next call');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-event-hub-'));
  const eventsPath = path.join(root, 'events.jsonl');
  const statePath = path.join(root, 'events.state.json');
  try {
    const retained = new EventLog(eventsPath, statePath, {
      maxActiveBytes: 1,
      maxSegments: 2,
      maxSegmentAgeMs: 60_000,
    });
    for (let index = 1; index <= 5; index++) append(retained, `retained.${index}`);
    const segmentNames = fs.readdirSync(root).filter(name => name.endsWith('.segment'));
    assert.equal(segmentNames.length, 2, 'rotation keeps only the configured number of segments');
    assert.deepEqual(retained.read().map(event => event.seq), [3, 4, 5]);
    assert.equal(retained.readLastSeq(), 5, 'state preserves the monotonic sequence across pruned segments');

    const restarted = new EventLog(eventsPath, statePath, {
      maxActiveBytes: 1,
      maxSegments: 2,
      maxSegmentAgeMs: 60_000,
    });
    assert.equal(append(restarted, 'retained.6').seq, 6);
    assert.deepEqual(restarted.read().map(event => event.seq), [4, 5, 6]);

    const recoveryEventsPath = path.join(root, 'recovery-events.jsonl');
    const recoveryStatePath = path.join(root, 'recovery-events.state.json');
    const recovery = new EventLog(recoveryEventsPath, recoveryStatePath, {
      maxActiveBytes: 1,
      maxSegments: 0,
    });
    assert.equal(append(recovery, 'recovery.1').seq, 1);
    fs.rmSync(recoveryStatePath, { force: true });
    assert.equal(append(recovery, 'recovery.2').seq, 2, 'rotation recovers seq before pruning old segments');
    assert.deepEqual(recovery.read().map(event => event.seq), [2]);

    const liveEventsPath = path.join(root, 'live-events.jsonl');
    const liveStatePath = path.join(root, 'live-events.state.json');
    const localLog = new CountingEventLog(liveEventsPath, liveStatePath);
    const externalLog = new EventLog(liveEventsPath, liveStatePath);
    const hub = new EventHub(localLog, { pollIntervalMs: 20 });
    const first = hub.subscribe(0);
    const second = hub.subscribe(0);
    assert.equal(localLog.readCalls, 1, 'additional subscribers reuse the EventHub history load');

    const local = append(localLog, 'local.immediate');
    assert.equal((await first.next()).value?.seq, local.seq);
    assert.equal((await second.next()).value?.seq, local.seq);

    const external = append(externalLog, 'external.tailed');
    const externalResult = await Promise.race([
      first.next(),
      new Promise<IteratorResult<HydraEvent>>((_, reject) => setTimeout(() => reject(new Error('external tail timeout')), 500)),
    ]);
    assert.equal(externalResult.value?.seq, external.seq, 'the single tailer observes external writers');
    await second.return?.();
    await expectNoEvent(first, 80);
    hub.dispose();

    const boundedHub = new EventHub(localLog, { pollIntervalMs: 10_000, maxHistoryEvents: 1 });
    const bounded = boundedHub.subscribe(0);
    assert.equal((await bounded.next()).value?.seq, external.seq, 'in-memory replay obeys its history bound');
    await bounded.return?.();
    boundedHub.dispose();

    const gapHub = new EventHub(localLog, { pollIntervalMs: 10_000 });
    const gap = gapHub.subscribe(localLog.readLastSeq());
    const externalBeforeLocal = append(externalLog, 'external.before-local');
    const localAfterExternal = append(localLog, 'local.after-external');
    assert.equal((await gap.next()).value?.seq, externalBeforeLocal.seq, 'local fan-out fills an external sequence gap');
    assert.equal((await gap.next()).value?.seq, localAfterExternal.seq, 'local event follows the external event in order');
    await gap.return?.();
    gapHub.dispose();

    const cancellationHub = new EventHub(localLog, { pollIntervalMs: 10_000 });
    const cancellation = cancellationHub.subscribe(localLog.readLastSeq());
    const pending = cancellation.next();
    const started = Date.now();
    await cancellation.return?.();
    assert.ok(Date.now() - started < 50, 'idle subscriptions cancel immediately');
    assert.equal((await pending).done, true);
    cancellationHub.dispose();

    console.log('eventHubSmoke: ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
