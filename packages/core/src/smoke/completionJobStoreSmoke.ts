/**
 * Smoke test: durable completion job store.
 *
 * Run: node packages/core/out/smoke/completionJobStoreSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompletionJobStore } from '../core/completionJobStore';

function createStore(root: string, now: () => number = Date.now): CompletionJobStore {
  return new CompletionJobStore(path.join(root, 'completion-jobs.json'), now);
}

function testIdempotentArmAndFire(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-idempotent-'));
  try {
    let now = Date.parse('2026-07-10T00:00:00.000Z');
    const store = createStore(root, () => now++);
    const input = { workerId: 7, lifecycleEpoch: 'epoch-7', runId: 'run-7' };
    const first = store.armForDispatch(input, { runtimeActive: true, runtimeRunId: input.runId });
    const duplicate = store.armForDispatch(input, { runtimeActive: true, runtimeRunId: input.runId });
    assert.equal(first.created, true);
    assert.equal(first.adopted, false);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.jobId, first.job.jobId);
    assert.equal(store.list('pending').length, 1);

    const fired = store.markFired(first.job.jobId, input);
    const firedAgain = store.markFired(first.job.jobId, input);
    assert.equal(fired.changed, true);
    assert.equal(fired.job.status, 'fired');
    assert.equal(firedAgain.changed, false);
    assert.equal(firedAgain.job.firedAt, fired.job.firedAt);
    assert.equal(store.getPending(input.workerId), undefined);

    assert.throws(
      () => store.markFired(first.job.jobId, { ...input, runId: 'wrong-run' }),
      /identity does not match/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testConcurrentFirstDispatchConverges(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-converge-'));
  try {
    const firstStore = createStore(root);
    const secondStore = createStore(root);
    const first = firstStore.armForDispatch(
      { workerId: 8, lifecycleEpoch: 'epoch-8', runId: 'proposed-run-a' },
      { runtimeActive: false, runtimeRunId: 'completed-run' },
    );
    const second = secondStore.armForDispatch(
      { workerId: 8, lifecycleEpoch: 'epoch-8', runId: 'proposed-run-b' },
      { runtimeActive: false, runtimeRunId: 'completed-run' },
    );
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.adopted, true);
    assert.equal(second.job.jobId, first.job.jobId);
    assert.equal(second.job.runId, 'proposed-run-a');
    assert.equal(firstStore.list('pending').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testEndedRunIsCancelledBeforeNewArm(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-new-run-'));
  try {
    const store = createStore(root);
    const old = store.armForDispatch(
      { workerId: 9, lifecycleEpoch: 'epoch-9', runId: 'old-run' },
      { runtimeActive: true, runtimeRunId: 'old-run' },
    );
    const next = store.armForDispatch(
      { workerId: 9, lifecycleEpoch: 'epoch-9', runId: 'new-run' },
      { runtimeActive: false, runtimeRunId: 'old-run' },
    );
    assert.equal(next.created, true);
    assert.notEqual(next.job.jobId, old.job.jobId);
    assert.equal(store.get(old.job.jobId)?.status, 'cancelled');
    assert.equal(store.get(old.job.jobId)?.cancelReason, 'superseded-by-new-run');
    assert.equal(store.getPending(9)?.jobId, next.job.jobId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCancellationFilters(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-cancel-'));
  try {
    const store = createStore(root);
    const workerA = store.armForDispatch(
      { workerId: 10, lifecycleEpoch: 'epoch-10', runId: 'run-10' },
      { runtimeActive: true, runtimeRunId: 'run-10' },
    );
    store.armForDispatch(
      { workerId: 11, lifecycleEpoch: 'epoch-11', runId: 'run-11' },
      { runtimeActive: true, runtimeRunId: 'run-11' },
    );

    assert.deepEqual(store.cancelPending(10, 'worker-stopped', { runId: 'other-run' }), []);
    const cancelled = store.cancelPending(10, 'worker-stopped', { lifecycleEpoch: 'epoch-10' });
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].jobId, workerA.job.jobId);
    assert.equal(cancelled[0].status, 'cancelled');
    assert.equal(cancelled[0].cancelReason, 'worker-stopped');
    assert.equal(store.list('pending').length, 1);
    assert.equal(store.list('pending')[0].workerId, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCancelPendingOutsideEpoch(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-epoch-cancel-'));
  try {
    const store = createStore(root);
    const old = store.armForDispatch(
      { workerId: 15, lifecycleEpoch: 'epoch-old', runId: 'run-old' },
      { runtimeActive: true, runtimeRunId: 'run-old' },
    );
    const cancelled = store.cancelPendingOutsideEpoch(15, 'epoch-new', 'stale-lifecycle-epoch');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].jobId, old.job.jobId);
    assert.equal(cancelled[0].cancelReason, 'stale-lifecycle-epoch');
    assert.deepEqual(store.cancelPendingOutsideEpoch(15, 'epoch-new', 'stale-lifecycle-epoch'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testFailClosedPersistence(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-corrupt-'));
  const filePath = path.join(root, 'completion-jobs.json');
  try {
    fs.writeFileSync(filePath, '{bad-json', 'utf-8');
    assert.throws(() => new CompletionJobStore(filePath).list(), /not valid JSON/);

    fs.writeFileSync(filePath, JSON.stringify({ version: 2, jobs: [] }), 'utf-8');
    assert.throws(() => new CompletionJobStore(filePath).list(), /unsupported version or shape/);

    const duplicatePending = {
      version: 1,
      jobs: [
        {
          version: 1,
          jobId: 'job-a',
          workerId: 12,
          lifecycleEpoch: 'epoch-12',
          runId: 'run-a',
          status: 'pending',
          armedAt: '2026-07-10T00:00:00.000Z',
        },
        {
          version: 1,
          jobId: 'job-b',
          workerId: 12,
          lifecycleEpoch: 'epoch-12',
          runId: 'run-b',
          status: 'pending',
          armedAt: '2026-07-10T00:00:01.000Z',
        },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(duplicatePending), 'utf-8');
    assert.throws(() => new CompletionJobStore(filePath).list(), /multiple pending jobs/);

    const invalidCancelled = {
      version: 1,
      jobs: [{
        version: 1,
        jobId: 'job-c',
        workerId: 13,
        lifecycleEpoch: 'epoch-13',
        runId: 'run-13',
        status: 'cancelled',
        armedAt: '2026-07-10T00:00:00.000Z',
      }],
    };
    fs.writeFileSync(filePath, JSON.stringify(invalidCancelled), 'utf-8');
    assert.throws(() => new CompletionJobStore(filePath).list(), /requires cancelledAt and cancelReason/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testStaleLockRecovery(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-job-stale-lock-'));
  const filePath = path.join(root, 'completion-jobs.json');
  const lockPath = `${filePath}.lock`;
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'abandoned-owner'), '999999', 'utf-8');
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const armed = new CompletionJobStore(filePath).armForDispatch(
      { workerId: 14, lifecycleEpoch: 'epoch-14', runId: 'run-14' },
      { runtimeActive: true, runtimeRunId: 'run-14' },
    );

    assert.equal(armed.created, true);
    assert.equal(armed.job.status, 'pending');
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  testIdempotentArmAndFire();
  testConcurrentFirstDispatchConverges();
  testEndedRunIsCancelledBeforeNewArm();
  testCancellationFilters();
  testCancelPendingOutsideEpoch();
  testFailClosedPersistence();
  testStaleLockRecovery();
  console.log('completionJobStoreSmoke: ok');
}

main();
