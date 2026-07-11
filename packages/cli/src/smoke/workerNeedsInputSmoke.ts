/**
 * Smoke test: structured worker needs-input detection.
 *
 * Run: node out/smoke/workerNeedsInputSmoke.js
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompletionJobStore } from '@hydra/core/completionJobStore';
import { EventLog } from '@hydra/core/events';
import { NotificationStore } from '@hydra/core/notifications';
import type { WorkerInfo } from '@hydra/core/sessionManager';
import {
  classifyCodexNeedsInputTranscriptText,
  classifyCodexRuntimeTranscriptText,
  classifyWorkerNeedsInputEvent,
  type WorkerNeedsInputSignal,
} from '@hydra/core/workerNeedsInputClassifier';
import { publishWorkerNeedsInputNotification } from '@hydra/core/workerAttentionNotifications';
import { WorkerNeedsInputMonitor } from '@hydra/core/workerNeedsInputMonitor';
import { WorkerRuntimeCoordinator } from '@hydra/core/workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from '@hydra/core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '@hydra/core/workerRuntimeV2';

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
}

function setupContext(): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-needs-input-'));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  return { tmp, home, hydraHome, configPath };
}

async function withProcessEnv<T>(ctx: TestContext, fn: () => Promise<T> | T): Promise<T> {
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
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'repo',
    sessionName: 'repo_worker_feat_input',
    displayName: 'feat/input',
    workerId: 9,
    lifecycleEpoch: 'epoch-worker-9',
    sessionAliases: [],
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: 'feat/input',
    slug: 'feat-input',
    status: 'running',
    attached: false,
    agent: 'claude',
    workdir: '/tmp/hydra-worktree',
    tmuxSession: 'repo_worker_feat_input',
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: 'repo_copilot',
    ...overrides,
  };
}

function writeSessions(ctx: TestContext, worker: WorkerInfo): void {
  fs.writeFileSync(
    path.join(ctx.hydraHome, 'sessions.json'),
    JSON.stringify({
      copilots: {
        repo_copilot: {
          sessionName: 'repo_copilot',
          displayName: 'repo_copilot',
          status: 'running',
          attached: false,
          agent: 'codex',
          workdir: ctx.tmp,
          tmuxSession: 'repo_copilot',
          createdAt: '',
          lastSeenAt: '',
          sessionId: null,
        },
      },
      workers: {
        [worker.sessionName]: worker,
      },
      nextWorkerId: 10,
      updatedAt: new Date().toISOString(),
    }, null, 2),
  );
}

function assertSignal(signal: WorkerNeedsInputSignal | undefined, reason: string): WorkerNeedsInputSignal {
  assert.ok(signal, `Expected needs-input signal for ${reason}`);
  assert.equal(signal.fingerprint.length > 0, true);
  return signal;
}

async function testClassifier(): Promise<void> {
  assertSignal(classifyWorkerNeedsInputEvent({
    agent: 'claude',
    eventName: 'PermissionRequest',
    payload: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
  }), 'Claude PermissionRequest');

  assert.equal(classifyWorkerNeedsInputEvent({
    agent: 'claude',
    eventName: 'PreToolUse',
    payload: { permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'npm test' } },
  }), undefined, 'Claude PreToolUse Bash must stay telemetry');

  assert.equal(classifyWorkerNeedsInputEvent({
    agent: 'claude',
    eventName: 'PreToolUse',
    payload: { permission_mode: 'default', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which color?' }] } },
  }), undefined, 'Claude AskUserQuestion default mode defers notification');

  const question = assertSignal(classifyWorkerNeedsInputEvent({
    agent: 'claude',
    eventName: 'PreToolUse',
    payload: {
      permission_mode: 'bypassPermissions',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
    },
  }), 'Claude AskUserQuestion bypass');
  assert.equal(question.reason, 'ask-user-question');
  assert.match(question.body, /Which color/);

  const exitPlan = assertSignal(classifyWorkerNeedsInputEvent({
    agent: 'claude',
    eventName: 'PreToolUse',
    payload: {
      permission_mode: 'bypassPermissions',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# Plan\nRun tests.' },
    },
  }), 'Claude ExitPlanMode bypass');
  assert.equal(exitPlan.reason, 'exit-plan');
  assert.match(exitPlan.body, /Run tests/);

  assert.equal(classifyWorkerNeedsInputEvent({
    agent: 'codex',
    eventName: 'PermissionRequest',
    payload: { tool_name: 'shell' },
  }), undefined, 'Codex PermissionRequest must not become needs-input');

  const codexEvent = assertSignal(classifyCodexNeedsInputTranscriptText([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
    '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-1","turn_id":"turn-1","questions":[{"question":"Pick a branch?"}]}}',
  ].join('\n')), 'Codex event_msg request_user_input');
  assert.equal(codexEvent.reason, 'request-user-input');
  assert.match(codexEvent.body, /Pick a branch/);

  const codexFunctionCall = assertSignal(classifyCodexNeedsInputTranscriptText([
    '{"type":"turn_context","payload":{"turn_id":"turn-2"}}',
    '{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call-2","arguments":"{\\"questions\\":[{\\"question\\":\\"Approve plan?\\"}]}"} }',
  ].join('\n')), 'Codex response_item request_user_input');
  assert.match(codexFunctionCall.body, /Approve plan/);

  assert.equal(classifyCodexNeedsInputTranscriptText([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-3"}}',
    '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-3","turn_id":"turn-3","questions":[{"question":"Pick?"}]}}',
    '{"type":"event_msg","payload":{"type":"turn_complete","turn_id":"turn-3"}}',
  ].join('\n')), undefined, 'completed Codex turn must not publish stale needs-input');

  assert.equal(classifyCodexNeedsInputTranscriptText([
    '{"type":"turn_context","payload":{"turn_id":"turn-old"}}',
    '{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call-old","arguments":"{\\"questions\\":[{\\"question\\":\\"Old question?\\"}]}"}}',
    '{"type":"turn_context","payload":{"turn_id":"turn-new"}}',
  ].join('\n')), undefined, 'a new Codex turn context must not retain the previous question');

  const resolvedTranscript = [
    '{"type":"turn_context","payload":{"turn_id":"turn-resolved"}}',
    '{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call-resolved","arguments":"{\\"questions\\":[{\\"question\\":\\"Continue?\\"}]}"}}',
    '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-resolved","output":"approved"}}',
  ].join('\n');
  assert.equal(
    classifyCodexNeedsInputTranscriptText(resolvedTranscript),
    undefined,
    'matching Codex function_call_output must resolve needs-input',
  );
  assert.equal(classifyCodexRuntimeTranscriptText(resolvedTranscript)?.reason, 'input-resolved');

  const abortedTranscript = [
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-aborted"}}',
    '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-aborted","turn_id":"turn-aborted","questions":[{"question":"Continue?"}]}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-aborted"}}',
  ].join('\n');
  assert.equal(
    classifyCodexNeedsInputTranscriptText(abortedTranscript),
    undefined,
    'Codex turn_aborted must resolve needs-input',
  );
  assert.equal(classifyCodexRuntimeTranscriptText(abortedTranscript)?.reason, 'turn-aborted');
}

async function testPublisher(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const worker = createWorker();
      const signal = assertSignal(classifyWorkerNeedsInputEvent({
        agent: 'claude',
        eventName: 'PermissionRequest',
        payload: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      }), 'publisher signal');
      const first = publishWorkerNeedsInputNotification(worker, signal, { eventSource: 'hook' });
      assert.equal(first.created, true);
      assert.equal(first.notification.kind, 'needs-input');
      assert.equal(first.notification.targetSession, worker.copilotSessionName);
      assert.equal(first.notification.sourceSession, worker.sessionName);
      assert.equal(first.notification.action?.type, 'open-session');
      assert.equal(first.notification.action?.session, worker.sessionName);
      assert.match(first.notification.dedupeKey || '', /^worker-needs-input:/);

      const duplicate = publishWorkerNeedsInputNotification(worker, signal, { eventSource: 'hook' });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.notification?.id, first.notification.id);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testHookCliE2e(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const worker = createWorker();
      writeSessions(ctx, worker);

      const cliPath = path.join(__dirname, '..', 'cli', 'index.js');
      const result = spawnSync(
        process.execPath,
        [cliPath, '--json', 'hooks', 'needs-input', '--agent', 'claude', '--session', worker.sessionName, '--event', 'PermissionRequest'],
        {
          cwd: ctx.tmp,
          env: { ...process.env },
          input: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
          encoding: 'utf-8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'created');
      assert.equal(output.notification.kind, 'needs-input');

      const ignored = spawnSync(
        process.execPath,
        [cliPath, '--json', 'hooks', 'needs-input', '--agent', 'claude', '--session', worker.sessionName, '--event', 'PreToolUse'],
        {
          cwd: ctx.tmp,
          env: { ...process.env },
          input: JSON.stringify({ hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'AskUserQuestion' }),
          encoding: 'utf-8',
        },
      );
      assert.equal(ignored.status, 0, ignored.stderr);
      assert.equal(JSON.parse(ignored.stdout).status, 'ignored');

      const stored = new NotificationStore().list().notifications;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].kind, 'needs-input');
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testNormalizedHookCliE2e(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const worker = createWorker();
      writeSessions(ctx, worker);
      const eventLog = new EventLog(
        path.join(ctx.hydraHome, 'events.jsonl'),
        path.join(ctx.hydraHome, 'events.state.json'),
      );
      const runtimeStore = new WorkerRuntimeStateStoreV2(
        path.join(ctx.hydraHome, 'worker-runtime-state-v2.json'),
      );
      const compatibilityStore = new WorkerRuntimeStateStore(
        path.join(ctx.hydraHome, 'worker-runtime-state.json'),
        eventLog,
      );
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
      const runId = 'run-hook-cli';
      assert.equal(runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch: worker.lifecycleEpoch!,
        runId,
        revision: 0,
        state: 'running',
        signalId: 'lifecycle:run-hook-cli',
        origin: 'lifecycle',
        reason: 'message-delivery',
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }).outcome, 'applied');
      new CompletionJobStore(path.join(ctx.hydraHome, 'completion-jobs.json')).armForDispatch({
        workerId: worker.workerId,
        lifecycleEpoch: worker.lifecycleEpoch!,
        runId,
      }, { runtimeActive: true, runtimeRunId: runId });

      const cliPath = path.join(__dirname, '..', 'cli', 'index.js');
      const baseArgs = [
        cliPath,
        '--json',
        'hooks',
        'signal',
        '--worker-id',
        String(worker.workerId),
        '--lifecycle-epoch',
        worker.lifecycleEpoch!,
        '--agent',
        'claude',
      ];
      const needsInput = spawnSync(
        process.execPath,
        [...baseArgs, '--event', 'PermissionRequest'],
        {
          cwd: ctx.tmp,
          env: { ...process.env },
          input: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            tool_name: 'Bash',
            tool_use_id: 'tool-cli-1',
            tool_input: { command: 'npm test' },
          }),
          encoding: 'utf-8',
        },
      );
      assert.equal(needsInput.status, 0, needsInput.stderr);
      assert.equal(JSON.parse(needsInput.stdout).status, 'applied');
      assert.equal(runtimeStore.get(worker.workerId)?.state, 'needs-input');

      const resolved = spawnSync(
        process.execPath,
        [...baseArgs, '--event', 'PostToolUse'],
        {
          cwd: ctx.tmp,
          env: { ...process.env },
          input: JSON.stringify({
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_use_id: 'tool-cli-1',
            tool_response: { success: true },
          }),
          encoding: 'utf-8',
        },
      );
      assert.equal(resolved.status, 0, resolved.stderr);
      const resolvedOutput = JSON.parse(resolved.stdout);
      assert.equal(resolvedOutput.status, 'applied');
      assert.equal(resolvedOutput.resolvedNotifications, 1);
      assert.equal(runtimeStore.get(worker.workerId)?.state, 'running');
      const notifications = new NotificationStore().listOccurrences();
      assert.equal(notifications.filter(item => item.kind === 'needs-input' && item.status === 'resolved').length, 1);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testCodexMonitor(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const transcript = path.join(ctx.tmp, 'rollout-codex-session.jsonl');
      fs.writeFileSync(transcript, [
        '{"type":"session_meta","payload":{"id":"codex-session","cwd":"/tmp/hydra-worktree"}}',
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-monitor"}}',
        '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-monitor","turn_id":"turn-monitor","questions":[{"question":"Which demo path should I use?"}]}}',
      ].join('\n'));
      const worker = createWorker({
        agent: 'codex',
        sessionId: 'codex-session',
        agentSessionFile: transcript,
      });
      writeSessions(ctx, worker);

      const monitor = new WorkerNeedsInputMonitor({
        sessionsFile: path.join(ctx.hydraHome, 'sessions.json'),
        pollIntervalMs: 1000,
      });
      try {
        monitor.scanOnce();
        monitor.scanOnce();
      } finally {
        monitor.dispose();
      }

      const stored = new NotificationStore().list().notifications;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].kind, 'needs-input');
      assert.equal(stored[0].targetSession, worker.copilotSessionName);
      assert.equal(stored[0].sourceSession, worker.sessionName);
      assert.match(stored[0].body, /Which demo path/);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testClassifier();
  await testPublisher();
  await testHookCliE2e();
  await testNormalizedHookCliE2e();
  await testCodexMonitor();
  console.log('workerNeedsInputSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
