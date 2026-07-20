/**
 * Smoke test: leased, cursor-based Codex attention supervision.
 *
 * Run: node out/smoke/workerAttentionSupervisorSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexTranscriptCursorStore } from '../core/codexTranscriptCursorStore';
import { CompletionJobStore } from '../core/completionJobStore';
import { EventLog } from '../core/events';
import { NotificationStore } from '../core/notifications';
import type { WorkerInfo } from '../core/sessionManager';
import { WorkerAttentionLeaseStore } from '../core/workerAttentionLease';
import { WorkerAttentionSupervisor } from '../core/workerAttentionSupervisor';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '../core/workerRuntimeV2';
import { WorkerRuntimeCoordinator } from '../core/workerRuntimeCoordinator';

interface TestContext {
  root: string;
  hydraHome: string;
  sessionsFile: string;
  transcriptFile: string;
  worker: WorkerInfo;
  cursorStore: CodexTranscriptCursorStore;
  leaseStore: WorkerAttentionLeaseStore;
  notificationStore: NotificationStore;
  runtimeStateStore: WorkerRuntimeStateStore;
  runtimeV2Store: WorkerRuntimeStateStoreV2;
  completionJobStore: CompletionJobStore;
  eventLog: EventLog;
}

class FailOnceCursorStore extends CodexTranscriptCursorStore {
  private failNextWrite = true;

  override set(cursor: Parameters<CodexTranscriptCursorStore['set']>[0]) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('injected cursor write failure');
    }
    return super.set(cursor);
  }
}

function createContext(label: string, workerId: number): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const hydraHome = path.join(root, 'hydra');
  const sessionsFile = path.join(hydraHome, 'sessions.json');
  const transcriptFile = path.join(root, 'codex-transcript.jsonl');
  fs.mkdirSync(hydraHome, { recursive: true });
  const now = new Date().toISOString();
  const worker: WorkerInfo = {
    source: 'repo',
    sessionName: `repo_worker_${workerId}`,
    displayName: `worker-${workerId}`,
    workerId,
    lifecycleEpoch: `epoch-${workerId}`,
    sessionAliases: [],
    repo: 'hydra',
    repoRoot: root,
    branch: `feat/worker-${workerId}`,
    slug: `worker-${workerId}`,
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir: root,
    tmuxSession: `repo_worker_${workerId}`,
    createdAt: now,
    lastSeenAt: now,
    sessionId: `codex-session-${workerId}`,
    agentSessionFile: transcriptFile,
    copilotSessionName: 'repo_copilot',
  };
  writeSessions(sessionsFile, worker);

  const eventLog = new EventLog(
    path.join(hydraHome, 'events.jsonl'),
    path.join(hydraHome, 'events.state.json'),
  );
  const runtimeV2Store = new WorkerRuntimeStateStoreV2(
    path.join(hydraHome, 'worker-runtime-state-v2.json'),
  );
  const runtimeStateStore = new WorkerRuntimeStateStore(
    path.join(hydraHome, 'worker-runtime-state.json'),
    eventLog,
  );
  const notificationStore = new NotificationStore(
    path.join(hydraHome, 'notifications.json'),
    1000,
    eventLog,
    undefined,
    Date.now,
    undefined,
    runtimeV2Store,
  );
  return {
    root,
    hydraHome,
    sessionsFile,
    transcriptFile,
    worker,
    cursorStore: new CodexTranscriptCursorStore(path.join(hydraHome, 'codex-transcript-cursors.json')),
    leaseStore: new WorkerAttentionLeaseStore(path.join(hydraHome, 'worker-attention-supervisor-lease.json')),
    notificationStore,
    runtimeStateStore,
    runtimeV2Store,
    completionJobStore: new CompletionJobStore(path.join(hydraHome, 'completion-jobs.json')),
    eventLog,
  };
}

function createSupervisor(
  ctx: TestContext,
  producerKind: 'extension' | 'sidecar',
  ownerId: string,
): WorkerAttentionSupervisor {
  return new WorkerAttentionSupervisor({
    producerKind,
    ownerId,
    sessionsFile: ctx.sessionsFile,
    pollIntervalMs: 250,
    leaseTtlMs: 2000,
    leaseStore: ctx.leaseStore,
    cursorStore: ctx.cursorStore,
    notificationStore: ctx.notificationStore,
    runtimeStateStore: ctx.runtimeStateStore,
    runtimeV2Store: ctx.runtimeV2Store,
    completionJobStore: ctx.completionJobStore,
    eventLog: ctx.eventLog,
  });
}

function seedRunningRuntime(
  ctx: TestContext,
  reason: string,
  lifecycleEpoch = ctx.worker.lifecycleEpoch!,
  runId = `run-${ctx.worker.workerId}`,
): void {
  const coordinator = new WorkerRuntimeCoordinator(
    workerId => workerId === ctx.worker.workerId ? {
      workerId,
      sessionName: ctx.worker.sessionName,
      lifecycleEpoch,
      agent: ctx.worker.agent,
      workdir: ctx.worker.workdir,
    } : undefined,
    ctx.runtimeV2Store,
    ctx.runtimeStateStore,
    ctx.eventLog,
  );
  const applied = coordinator.apply({
    workerId: ctx.worker.workerId,
    sessionName: ctx.worker.sessionName,
    lifecycleEpoch,
    runId,
    revision: 0,
    state: 'running',
    signalId: `seed:${ctx.worker.workerId}:${lifecycleEpoch}:${runId}`,
    origin: 'lifecycle',
    reason,
    observedAt: new Date().toISOString(),
    agent: ctx.worker.agent,
    workdir: ctx.worker.workdir,
  }, 'cli');
  assert.equal(applied.outcome, 'applied');
}

async function testOwnerScopedRuntimeReconciliation(): Promise<void> {
  const cases = [
    { label: 'legacy-lifecycle', reason: 'worker-started' },
    { label: 'direct-terminal', reason: 'terminal-direct-input' },
    { label: 'untracked-dispatch', reason: 'worker-send' },
  ];
  for (const [index, testCase] of cases.entries()) {
    const ctx = createContext(`hydra-attention-reconcile-${testCase.label}-`, 60 + index);
    const supervisor = createSupervisor(ctx, 'sidecar', `reconcile-${testCase.label}`);
    try {
      seedRunningRuntime(ctx, testCase.reason);
      const candidate = ctx.runtimeV2Store.get(ctx.worker.workerId)!;
      const scan = await supervisor.scanOnce();
      assert.equal(scan.leaseAcquired, true);
      const repaired = ctx.runtimeV2Store.get(ctx.worker.workerId)!;
      assert.equal(repaired.state, 'unknown');
      assert.notEqual(repaired.state, 'idle');
      assert.equal(repaired.reason, 'completion-tracking-unavailable');
      assert.equal(repaired.runId, candidate.runId);
      assert.equal(
        repaired.signalId,
        `runtime-reconcile:${ctx.worker.workerId}:${ctx.worker.lifecycleEpoch}:${candidate.signalId}`,
      );
      assert.equal(ctx.runtimeStateStore.get(ctx.worker.sessionName)?.state, 'unknown');

      await supervisor.scanOnce();
      assert.equal(
        ctx.runtimeV2Store.get(ctx.worker.workerId)?.revision,
        repaired.revision,
        'repeated reconciliation must be a no-op',
      );
    } finally {
      supervisor.dispose();
      removeTree(ctx.root);
    }
  }
}

async function testRuntimeReconciliationGuards(): Promise<void> {
  const tracked = createContext('hydra-attention-reconcile-tracked-', 63);
  const trackedSupervisor = createSupervisor(tracked, 'sidecar', 'reconcile-tracked');
  try {
    seedRunningRuntime(tracked, 'worker-send', undefined, 'tracked-run');
    tracked.completionJobStore.armForDispatch({
      workerId: tracked.worker.workerId,
      lifecycleEpoch: tracked.worker.lifecycleEpoch!,
      runId: 'tracked-run',
    }, { runtimeActive: true, runtimeRunId: 'tracked-run' });
    await trackedSupervisor.scanOnce();
    assert.equal(tracked.runtimeV2Store.get(tracked.worker.workerId)?.state, 'running');
  } finally {
    trackedSupervisor.dispose();
    removeTree(tracked.root);
  }

  const stale = createContext('hydra-attention-reconcile-stale-epoch-', 64);
  const staleSupervisor = createSupervisor(stale, 'sidecar', 'reconcile-stale');
  try {
    seedRunningRuntime(stale, 'worker-started', 'old-epoch', 'old-run');
    await staleSupervisor.scanOnce();
    assert.equal(stale.runtimeV2Store.get(stale.worker.workerId)?.state, 'running');
    assert.equal(stale.runtimeV2Store.get(stale.worker.workerId)?.lifecycleEpoch, 'old-epoch');
  } finally {
    staleSupervisor.dispose();
    removeTree(stale.root);
  }
}

async function testIncrementalCursorResolutionAbortAndLease(): Promise<void> {
  const ctx = createContext('hydra-attention-supervisor-', 41);
  const extension = createSupervisor(ctx, 'extension', 'extension-test-owner');
  const sidecar = createSupervisor(ctx, 'sidecar', 'sidecar-test-owner');
  try {
    const runId = 'run-incremental';
    ctx.completionJobStore.armForDispatch({
      workerId: ctx.worker.workerId,
      lifecycleEpoch: ctx.worker.lifecycleEpoch!,
      runId,
    }, { runtimeActive: false, runtimeRunId: null });

    const taskStarted = '{"type":"event_msg","sequence":1,"payload":{"type":"task_started","turn_id":"turn-incremental"}}';
    const request = '{"type":"response_item","sequence":2,"payload":{"type":"function_call","name":"request_user_input","call_id":"call-incremental","arguments":"{\\"questions\\":[{\\"question\\":\\"Which path?\\"}]}"}}';
    const splitAt = Math.floor(request.length / 2);
    fs.writeFileSync(ctx.transcriptFile, `${taskStarted}\n${request.slice(0, splitAt)}`, 'utf-8');

    const first = await extension.scanOnce();
    assert.deepEqual(first, { leaseAcquired: true, workersScanned: 1, eventsProcessed: 0 });
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId), undefined);
    const partialCursor = ctx.cursorStore.get(ctx.worker.workerId);
    assert.ok(partialCursor);
    assert.equal(partialCursor.byteOffset, fs.statSync(ctx.transcriptFile).size);
    assert.notEqual(partialCursor.pendingBytesBase64, '');

    fs.appendFileSync(ctx.transcriptFile, request.slice(splitAt), 'utf-8');
    const second = await extension.scanOnce();
    assert.equal(second.eventsProcessed, 1);
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'needs-input');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 1);
    const resolvedCursor = ctx.cursorStore.get(ctx.worker.workerId);
    assert.equal(resolvedCursor?.pendingBytesBase64, '');
    assert.equal(resolvedCursor?.byteOffset, fs.statSync(ctx.transcriptFile).size);

    const noRescan = await extension.scanOnce();
    assert.equal(noRescan.eventsProcessed, 0);
    assert.equal(ctx.notificationStore.listOccurrences().filter(item => item.kind === 'needs-input').length, 1);

    const functionOutput = '{"type":"response_item","sequence":3,"payload":{"type":"function_call_output","call_id":"call-incremental","output":"approved"}}';
    fs.appendFileSync(ctx.transcriptFile, `\n${functionOutput}`, 'utf-8');
    const sidecarScan = await sidecar.scanOnce();
    assert.equal(sidecarScan.leaseAcquired, true);
    assert.equal(sidecarScan.eventsProcessed, 1);
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'running');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 0);
    assert.equal(ctx.notificationStore.listOccurrences('resolved').filter(item => item.kind === 'needs-input').length, 1);
    assert.equal(ctx.leaseStore.inspect()?.ownerKind, 'sidecar');

    const deniedExtension = await extension.scanOnce();
    assert.equal(deniedExtension.leaseAcquired, false, 'extension must yield to a live sidecar lease');

    const aborted = '{"type":"event_msg","sequence":4,"payload":{"type":"turn_aborted","turn_id":"turn-incremental"}}';
    fs.appendFileSync(ctx.transcriptFile, `\n${aborted}`, 'utf-8');
    const abortScan = await sidecar.scanOnce();
    assert.equal(abortScan.eventsProcessed, 1);
    const abortedRuntime = ctx.runtimeV2Store.get(ctx.worker.workerId);
    assert.equal(abortedRuntime?.state, 'idle');
    assert.equal(abortedRuntime?.reason, 'turn-aborted');
    assert.equal(ctx.completionJobStore.getPending(ctx.worker.workerId), undefined);
    assert.equal(ctx.completionJobStore.list('cancelled').length, 1);

    sidecar.dispose();
    const fallback = await extension.scanOnce();
    assert.equal(fallback.leaseAcquired, true, 'extension must reacquire after the sidecar releases');
    assert.equal(fallback.eventsProcessed, 0);
  } finally {
    extension.dispose();
    sidecar.dispose();
    removeTree(ctx.root);
  }
}

async function testTranscriptCompletionAndCursorRestart(): Promise<void> {
  const ctx = createContext('hydra-attention-completion-', 42);
  const supervisor = createSupervisor(ctx, 'sidecar', 'sidecar-completion-owner');
  try {
    const runId = 'run-completion';
    const armed = ctx.completionJobStore.armForDispatch({
      workerId: ctx.worker.workerId,
      lifecycleEpoch: ctx.worker.lifecycleEpoch!,
      runId,
    }, { runtimeActive: false, runtimeRunId: null });
    fs.writeFileSync(ctx.transcriptFile, [
      '{"type":"event_msg","sequence":1,"payload":{"type":"task_started","turn_id":"turn-historical"}}',
      '{"type":"event_msg","sequence":2,"payload":{"type":"turn_complete","turn_id":"turn-historical"}}',
    ].join('\n'), 'utf-8');

    const bootstrap = await supervisor.scanOnce();
    assert.equal(bootstrap.eventsProcessed, 0, 'initial recovery must not replay historical completion');
    assert.equal(ctx.completionJobStore.get(armed.job.jobId)?.status, 'pending');
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId), undefined);
    fs.appendFileSync(ctx.transcriptFile, [
      '',
      '{"type":"event_msg","sequence":10,"payload":{"type":"task_started","turn_id":"turn-complete"}}',
      '{"type":"event_msg","sequence":11,"payload":{"type":"turn_complete","turn_id":"turn-complete"}}',
    ].join('\n'), 'utf-8');

    const incremental = await supervisor.scanOnce();
    assert.equal(incremental.eventsProcessed, 2);
    const runtime = ctx.runtimeV2Store.get(ctx.worker.workerId);
    assert.equal(runtime?.state, 'idle');
    assert.equal(runtime?.reason, 'complete');
    assert.equal(runtime?.origin, 'codex-transcript');
    assert.equal(runtime?.runId, runId);
    assert.equal(ctx.completionJobStore.get(armed.job.jobId)?.status, 'fired');
    const completions = ctx.notificationStore.listOccurrences('active')
      .filter(item => item.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].runId, runId);

    supervisor.dispose();
    const restarted = createSupervisor(ctx, 'sidecar', 'sidecar-restarted-owner');
    try {
      const restartScan = await restarted.scanOnce();
      assert.equal(restartScan.eventsProcessed, 0, 'persisted byte offset must prevent transcript rescans');
      assert.equal(ctx.notificationStore.listOccurrences().filter(item => item.kind === 'complete').length, 1);

      fs.writeFileSync(
        ctx.transcriptFile,
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}',
        'utf-8',
      );
      const truncatedScan = await restarted.scanOnce();
      assert.equal(truncatedScan.eventsProcessed, 1, 'truncation must reset transcript identity progress');
      assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'running');
      assert.equal(ctx.cursorStore.get(ctx.worker.workerId)?.byteOffset, fs.statSync(ctx.transcriptFile).size);

      ctx.worker.lifecycleEpoch = 'epoch-42-restored';
      writeSessions(ctx.sessionsFile, ctx.worker);
      fs.appendFileSync(
        ctx.transcriptFile,
        '\n{"type":"event_msg","payload":{"type":"task_started","turn_id":"t3"}}',
        'utf-8',
      );
      const restoredScan = await restarted.scanOnce();
      assert.equal(
        restoredScan.eventsProcessed,
        1,
        'an epoch reset must continue at the persisted byte boundary without replaying history',
      );
      assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.lifecycleEpoch, 'epoch-42-restored');
      assert.equal(ctx.cursorStore.get(ctx.worker.workerId)?.lifecycleEpoch, 'epoch-42-restored');
    } finally {
      restarted.dispose();
    }
  } finally {
    supervisor.dispose();
    removeTree(ctx.root);
  }
}

async function testCodexExecApprovalLifecycle(): Promise<void> {
  const ctx = createContext('hydra-attention-approval-', 45);
  const supervisor = createSupervisor(ctx, 'sidecar', 'sidecar-approval-owner');
  try {
    const approvalCall = JSON.stringify({
      type: 'response_item',
      sequence: 2,
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call-approval',
        name: 'exec',
        input: [
          'const result = await tools.exec_command({',
          '  cmd: "printf approved > /tmp/approval.txt",',
          '  sandbox_permissions: "require_escalated",',
          '  justification: "Allow writing the requested file outside the worker?",',
          '});',
          'text(result);',
        ].join('\n'),
      },
    });
    fs.writeFileSync(ctx.transcriptFile, [
      '{"type":"event_msg","sequence":1,"payload":{"type":"task_started","turn_id":"turn-approval"}}',
      approvalCall,
    ].join('\n'), 'utf-8');
    const transcriptStat = fs.statSync(ctx.transcriptFile);
    ctx.cursorStore.set({
      version: 1,
      workerId: ctx.worker.workerId,
      lifecycleEpoch: ctx.worker.lifecycleEpoch!,
      transcript: {
        path: ctx.transcriptFile,
        device: transcriptStat.dev,
        inode: transcriptStat.ino,
      },
      byteOffset: transcriptStat.size,
      pendingBytesBase64: '',
      parserState: {
        currentTurnId: 'turn-approval',
      },
      updatedAt: new Date().toISOString(),
    });

    const waiting = await supervisor.scanOnce();
    assert.equal(
      waiting.eventsProcessed,
      1,
      'parser upgrade must recover an approval skipped by the old cursor',
    );
    const waitingRuntime = ctx.runtimeV2Store.get(ctx.worker.workerId);
    assert.equal(waitingRuntime?.state, 'needs-input');
    assert.equal(waitingRuntime?.reason, 'approval-required');
    const activeApproval = ctx.notificationStore.listOccurrences('active')
      .filter(item => item.kind === 'needs-input');
    assert.equal(activeApproval.length, 1);
    assert.equal(activeApproval[0].title, `Worker #${ctx.worker.workerId} needs approval`);
    assert.match(activeApproval[0].body, /outside the worker/);

    const approvalOutput = JSON.stringify({
      type: 'response_item',
      sequence: 3,
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-approval',
        output: [{ type: 'input_text', text: 'Script completed' }],
      },
    });
    fs.appendFileSync(ctx.transcriptFile, `\n${approvalOutput}`, 'utf-8');

    const resumed = await supervisor.scanOnce();
    assert.equal(resumed.eventsProcessed, 1);
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'running');
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.reason, 'input-resolved');
    assert.equal(
      ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length,
      0,
    );
    assert.equal(
      ctx.notificationStore.listOccurrences('resolved').filter(item => item.kind === 'needs-input').length,
      1,
    );
  } finally {
    supervisor.dispose();
    removeTree(ctx.root);
  }
}

async function testCursorWriteFailureReplaysIdempotently(): Promise<void> {
  const ctx = createContext('hydra-attention-replay-', 43);
  ctx.cursorStore = new FailOnceCursorStore(path.join(ctx.hydraHome, 'codex-transcript-cursors.json'));
  const supervisor = createSupervisor(ctx, 'sidecar', 'sidecar-replay-owner');
  try {
    fs.writeFileSync(ctx.transcriptFile, [
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-replay"}}',
      '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-replay","turn_id":"turn-replay","questions":[{"question":"Retry safely?"}]}}',
    ].join('\n'), 'utf-8');

    await assert.rejects(() => supervisor.scanOnce(), /injected cursor write failure/);
    assert.equal(ctx.cursorStore.get(ctx.worker.workerId), undefined);
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'needs-input');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 1);

    const replay = await supervisor.scanOnce();
    assert.equal(replay.eventsProcessed, 1);
    assert.equal(ctx.notificationStore.listOccurrences().filter(item => item.kind === 'needs-input').length, 1);
    assert.equal(ctx.cursorStore.get(ctx.worker.workerId)?.byteOffset, fs.statSync(ctx.transcriptFile).size);
  } finally {
    supervisor.dispose();
    removeTree(ctx.root);
  }
}

async function testInitialRecoveryClosesMatchingAbort(): Promise<void> {
  const ctx = createContext('hydra-attention-abort-recovery-', 44);
  const firstSupervisor = createSupervisor(ctx, 'sidecar', 'sidecar-abort-initial');
  try {
    ctx.completionJobStore.armForDispatch({
      workerId: ctx.worker.workerId,
      lifecycleEpoch: ctx.worker.lifecycleEpoch!,
      runId: 'run-abort-recovery',
    }, { runtimeActive: false, runtimeRunId: null });
    fs.writeFileSync(ctx.transcriptFile, [
      '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-abort-recovery"}}',
      '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-abort-recovery","turn_id":"turn-abort-recovery","questions":[{"question":"Abort recovery?"}]}}',
    ].join('\n'), 'utf-8');
    const initial = await firstSupervisor.scanOnce();
    assert.equal(initial.eventsProcessed, 1, 'initial recovery should restore only the active question');
    assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'needs-input');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 1);

    firstSupervisor.dispose();
    fs.rmSync(path.join(ctx.hydraHome, 'codex-transcript-cursors.json'), { force: true });
    fs.appendFileSync(
      ctx.transcriptFile,
      '\n{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-abort-recovery"}}',
      'utf-8',
    );
    const restarted = createSupervisor(ctx, 'sidecar', 'sidecar-abort-recovery');
    try {
      const recovered = await restarted.scanOnce();
      assert.equal(recovered.eventsProcessed, 1, 'initial recovery should apply a matching active abort only');
      assert.equal(ctx.runtimeV2Store.get(ctx.worker.workerId)?.state, 'idle');
      assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 0);
      assert.equal(ctx.notificationStore.listOccurrences('resolved').filter(item => item.kind === 'needs-input').length, 1);
      assert.equal(ctx.completionJobStore.list('cancelled').length, 1);
    } finally {
      restarted.dispose();
    }
  } finally {
    firstSupervisor.dispose();
    removeTree(ctx.root);
  }
}

function testStoresFailClosed(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-attention-corrupt-'));
  try {
    const cursorPath = path.join(root, 'cursors.json');
    fs.writeFileSync(cursorPath, '{not-json', 'utf-8');
    assert.throws(
      () => new CodexTranscriptCursorStore(cursorPath).get(1),
      /not valid JSON/,
    );

    const leasePath = path.join(root, 'lease.json');
    fs.writeFileSync(leasePath, JSON.stringify({ version: 1, ownerKind: 'sidecar' }), 'utf-8');
    assert.throws(
      () => new WorkerAttentionLeaseStore(leasePath).tryAcquire('extension', 'extension-owner'),
      /ownerId/,
    );
  } finally {
    removeTree(root);
  }
}

function writeSessions(filePath: string, worker: WorkerInfo): void {
  fs.writeFileSync(filePath, JSON.stringify({
    copilots: {
      repo_copilot: {
        sessionName: 'repo_copilot',
        displayName: 'repo_copilot',
        status: 'running',
        attached: false,
        agent: 'codex',
        workdir: worker.workdir,
        tmuxSession: 'repo_copilot',
        createdAt: '',
        lastSeenAt: '',
        sessionId: null,
      },
    },
    workers: { [worker.sessionName]: worker },
    nextWorkerId: worker.workerId + 1,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function removeTree(root: string): void {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function main(): Promise<void> {
  await testOwnerScopedRuntimeReconciliation();
  await testRuntimeReconciliationGuards();
  await testIncrementalCursorResolutionAbortAndLease();
  await testTranscriptCompletionAndCursorRestart();
  await testCodexExecApprovalLifecycle();
  await testCursorWriteFailureReplaysIdempotently();
  await testInitialRecoveryClosesMatchingAbort();
  testStoresFailClosed();
  console.log('workerAttentionSupervisorSmoke: ok');
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
