/**
 * Smoke test: normalized Claude hook attention and runtime events.
 *
 * Run: node out/smoke/agentHookEventCoordinatorSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentHookEventCoordinator } from '../core/agentHookEventCoordinator';
import { CompletionJobStore } from '../core/completionJobStore';
import { EventLog } from '../core/events';
import { NotificationStore } from '../core/notifications';
import type { WorkerInfo } from '../core/sessionManager';
import { WorkerRuntimeCoordinator } from '../core/workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '../core/workerRuntimeV2';

interface TestContext {
  root: string;
  worker: WorkerInfo;
  runtimeStore: WorkerRuntimeStateStoreV2;
  notificationStore: NotificationStore;
  completionJobStore: CompletionJobStore;
  runtimeCoordinator: WorkerRuntimeCoordinator;
  coordinator: AgentHookEventCoordinator;
}

function createContext(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-agent-hook-event-'));
  const hydraHome = path.join(root, 'hydra');
  fs.mkdirSync(hydraHome, { recursive: true });
  const now = new Date().toISOString();
  const worker: WorkerInfo = {
    source: 'repo',
    sessionName: 'hydra_worker_claude',
    displayName: 'Claude worker',
    workerId: 51,
    lifecycleEpoch: 'epoch-claude-51',
    sessionAliases: [],
    repo: 'hydra',
    repoRoot: root,
    branch: 'feat/claude-hooks',
    slug: 'claude-hooks',
    status: 'running',
    attached: false,
    agent: 'claude',
    workdir: root,
    tmuxSession: 'hydra_worker_claude',
    createdAt: now,
    lastSeenAt: now,
    sessionId: 'claude-session-51',
    copilotSessionName: 'hydra_copilot',
  };
  const eventLog = new EventLog(
    path.join(hydraHome, 'events.jsonl'),
    path.join(hydraHome, 'events.state.json'),
  );
  const runtimeStore = new WorkerRuntimeStateStoreV2(
    path.join(hydraHome, 'worker-runtime-state-v2.json'),
  );
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
  const completionJobStore = new CompletionJobStore(
    path.join(hydraHome, 'completion-jobs.json'),
  );
  const resolveWorker = (workerId: number) => workerId === worker.workerId ? worker : undefined;
  const runtimeCoordinator = new WorkerRuntimeCoordinator(
    workerId => workerId === worker.workerId ? {
      workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: worker.lifecycleEpoch!,
      agent: worker.agent,
      workdir: worker.workdir,
    } : undefined,
    runtimeStore,
    compatibilityStore,
    eventLog,
  );
  const coordinator = new AgentHookEventCoordinator({
    resolveWorker,
    runtimeStore,
    compatibilityStore,
    notificationStore,
    completionJobStore,
    eventLog,
    runtimeCoordinator,
    eventSource: 'hook',
    lockPath: path.join(hydraHome, 'agent-hook-events.lock'),
  });
  return {
    root,
    worker,
    runtimeStore,
    notificationStore,
    completionJobStore,
    runtimeCoordinator,
    coordinator,
  };
}

function startRun(ctx: TestContext, runId: string): void {
  const current = ctx.runtimeStore.get(ctx.worker.workerId);
  const started = ctx.runtimeCoordinator.apply({
    workerId: ctx.worker.workerId,
    sessionName: ctx.worker.sessionName,
    lifecycleEpoch: ctx.worker.lifecycleEpoch!,
    runId,
    revision: (current?.revision ?? -1) + 1,
    state: 'running',
    signalId: `lifecycle:${runId}`,
    origin: 'lifecycle',
    reason: 'message-delivery',
    observedAt: new Date().toISOString(),
    agent: ctx.worker.agent,
    workdir: ctx.worker.workdir,
  });
  assert.equal(started.outcome, 'applied');
  ctx.completionJobStore.armForDispatch({
    workerId: ctx.worker.workerId,
    lifecycleEpoch: ctx.worker.lifecycleEpoch!,
    runId,
  }, { runtimeActive: true, runtimeRunId: runId });
}

function process(ctx: TestContext, eventName: string, payload: Record<string, unknown>) {
  return ctx.coordinator.process({
    workerId: ctx.worker.workerId,
    lifecycleEpoch: ctx.worker.lifecycleEpoch!,
    agent: 'claude',
    eventName,
    payload: { hook_event_name: eventName, ...payload },
  });
}

function testNeedsInputResolutionAndCorrelation(): void {
  const ctx = createContext();
  try {
    startRun(ctx, 'run-needs-input');
    const needsInput = process(ctx, 'PermissionRequest', {
      tool_name: 'Bash',
      tool_use_id: 'tool-permission-1',
      tool_input: { command: 'npm test' },
    });
    assert.equal(needsInput.status, 'applied');
    assert.equal(needsInput.status === 'applied' && needsInput.event.kind, 'needs-input');
    assert.equal(ctx.runtimeStore.get(ctx.worker.workerId)?.state, 'needs-input');
    assert.equal(ctx.completionJobStore.getPending(ctx.worker.workerId)?.runId, 'run-needs-input');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 1);

    const duplicate = process(ctx, 'PermissionRequest', {
      tool_name: 'Bash',
      tool_use_id: 'tool-permission-1',
      tool_input: { command: 'npm test' },
    });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(ctx.notificationStore.listOccurrences().filter(item => item.kind === 'needs-input').length, 1);

    const unrelated = process(ctx, 'PostToolUse', {
      tool_name: 'Read',
      tool_use_id: 'parallel-tool',
      tool_response: { success: true },
    });
    assert.deepEqual(
      { status: unrelated.status, reason: unrelated.status === 'ignored' ? unrelated.reason : undefined },
      { status: 'ignored', reason: 'correlation-mismatch' },
    );
    assert.equal(ctx.runtimeStore.get(ctx.worker.workerId)?.state, 'needs-input');

    const secondNeedsInput = process(ctx, 'PermissionRequest', {
      tool_name: 'Write',
      tool_use_id: 'tool-permission-2',
      tool_input: { file_path: '/tmp/result.txt' },
    });
    assert.equal(secondNeedsInput.status, 'applied');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 2);

    const resolved = process(ctx, 'PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tool-permission-1',
      tool_response: { success: true },
    });
    assert.equal(resolved.status, 'applied');
    assert.equal(resolved.status === 'applied' && resolved.resolvedNotifications, 1);
    assert.equal(ctx.runtimeStore.get(ctx.worker.workerId)?.state, 'needs-input');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 1);

    const secondResolved = process(ctx, 'PostToolUse', {
      tool_name: 'Write',
      tool_use_id: 'tool-permission-2',
      tool_response: { success: true },
    });
    assert.equal(secondResolved.status, 'applied');
    assert.equal(secondResolved.status === 'applied' && secondResolved.resolvedNotifications, 1);
    assert.equal(ctx.runtimeStore.get(ctx.worker.workerId)?.state, 'running');
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 0);
    assert.equal(ctx.notificationStore.listOccurrences('resolved').filter(item => item.kind === 'needs-input').length, 2);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

function testAskUserQuestionFailureStillResolves(): void {
  const ctx = createContext();
  try {
    startRun(ctx, 'run-question');
    const question = process(ctx, 'PreToolUse', {
      permission_mode: 'bypassPermissions',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tool-question-1',
      tool_input: { questions: [{ question: 'Which branch?' }] },
    });
    assert.equal(question.status, 'applied');
    const failed = process(ctx, 'PostToolUseFailure', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tool-question-1',
      error: 'Question was dismissed',
      is_interrupt: false,
    });
    assert.equal(failed.status, 'applied');
    assert.equal(ctx.runtimeStore.get(ctx.worker.workerId)?.state, 'running');
    assert.equal(ctx.notificationStore.listOccurrences('resolved').filter(item => item.kind === 'needs-input').length, 1);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

function testStopFailureCreatesErrorAndCancelsRun(): void {
  const ctx = createContext();
  try {
    startRun(ctx, 'run-stop-failure');
    process(ctx, 'PermissionRequest', {
      tool_name: 'Bash',
      tool_use_id: 'tool-error-1',
      tool_input: { command: 'npm test' },
    });
    const failed = process(ctx, 'StopFailure', {
      session_id: 'claude-session-51',
      error: 'rate_limit',
      error_details: '429 Too Many Requests for sk-ant-api03-abcdefghijklmnop',
      last_assistant_message: 'API Error: Rate limit reached',
    });
    assert.equal(failed.status, 'applied');
    assert.equal(failed.status === 'applied' && failed.event.kind, 'runtime-error');
    const runtime = ctx.runtimeStore.get(ctx.worker.workerId);
    assert.equal(runtime?.state, 'error');
    assert.equal(runtime?.reason, 'agent-stop-failure');
    assert.equal(ctx.completionJobStore.getPending(ctx.worker.workerId), undefined);
    assert.equal(ctx.completionJobStore.list('cancelled').length, 1);
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'error').length, 1);
    assert.equal(ctx.notificationStore.listOccurrences('active').filter(item => item.kind === 'needs-input').length, 0);
    const error = ctx.notificationStore.list().notifications.find(item => item.kind === 'error');
    assert.ok(error);
    assert.doesNotMatch(error.body, /sk-ant-api03-abcdefghijklmnop/);

    const duplicate = process(ctx, 'StopFailure', {
      session_id: 'claude-session-51',
      error: 'rate_limit',
      error_details: '429 Too Many Requests for sk-ant-api03-abcdefghijklmnop',
      last_assistant_message: 'API Error: Rate limit reached',
    });
    assert.deepEqual(
      { status: duplicate.status, reason: duplicate.status === 'ignored' ? duplicate.reason : undefined },
      { status: 'ignored', reason: 'no-active-run' },
      'a replay after the run is terminal must not create a second error occurrence',
    );
    assert.equal(ctx.notificationStore.listOccurrences().filter(item => item.kind === 'error').length, 1);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

function testStaleIdentityAndUnsupportedAgentsFailClosed(): void {
  const ctx = createContext();
  try {
    startRun(ctx, 'run-identity');
    const stale = ctx.coordinator.process({
      workerId: ctx.worker.workerId,
      lifecycleEpoch: 'stale-epoch',
      agent: 'claude',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash' },
    });
    assert.deepEqual(stale, { status: 'ignored', reason: 'stale-epoch' });
    const mismatch = ctx.coordinator.process({
      workerId: ctx.worker.workerId,
      lifecycleEpoch: ctx.worker.lifecycleEpoch!,
      agent: 'gemini',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash' },
    });
    assert.deepEqual(mismatch, { status: 'ignored', reason: 'agent-mismatch' });
    assert.equal(ctx.notificationStore.listOccurrences().length, 0);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

function main(): void {
  testNeedsInputResolutionAndCorrelation();
  testAskUserQuestionFailureStillResolves();
  testStopFailureCreatesErrorAndCancelsRun();
  testStaleIdentityAndUnsupportedAgentsFailClosed();
  console.log('agentHookEventCoordinatorSmoke: ok');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
