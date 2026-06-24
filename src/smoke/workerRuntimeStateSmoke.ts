/**
 * Smoke test: worker runtime state store, projections, and CLI surface.
 *
 * Run: node out/smoke/workerRuntimeStateSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventLog } from '../core/events';
import { NotificationStore } from '../core/notifications';
import type { WorkerInfo } from '../core/sessionManager';
import {
  WorkerRuntimeStateStore,
  type WorkerRuntimeSnapshot,
} from '../core/workerRuntimeState';
import {
  classifyCodexRuntimeTranscriptText,
  classifyWorkerNeedsInputEvent,
} from '../core/workerNeedsInputClassifier';
import { publishWorkerNeedsInputNotification } from '../core/workerAttentionNotifications';
import { WorkerNeedsInputMonitor } from '../core/workerNeedsInputMonitor';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

interface ListWorker {
  session: string;
  status: string;
  runtimeState?: {
    state: string;
    updatedAt: string | null;
    origin: string;
    reason?: string;
    notificationId?: string;
  };
}

function setupContext(prefix = 'hydra-runtime-state-'): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
    HYDRA_TELEMETRY: '0',
  };
  return { tmp, home, hydraHome, configPath, env };
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
    sessionName: 'repo_worker_runtime',
    displayName: 'runtime',
    workerId: 7,
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: 'issue-233',
    slug: 'issue-233',
    status: 'running',
    attached: false,
    agent: 'claude',
    workdir: '/tmp/hydra-runtime-worktree',
    tmuxSession: 'repo_worker_runtime',
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: 'repo_copilot',
    ...overrides,
  };
}

function readEvents(ctx: TestContext): Array<{ type: string; source: string; session?: string; payload?: Record<string, unknown> }> {
  const eventsPath = path.join(ctx.hydraHome, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as { type: string; source: string; session?: string; payload?: Record<string, unknown> });
}

async function testStoreEventsAndIdempotency(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, () => {
      const eventLog = new EventLog(
        path.join(ctx.hydraHome, 'events.jsonl'),
        path.join(ctx.hydraHome, 'events.state.json'),
      );
      const store = new WorkerRuntimeStateStore(
        path.join(ctx.hydraHome, 'worker-runtime-state.json'),
        eventLog,
      );

      const first = store.set({
        sessionName: 'repo_worker_runtime',
        state: 'running',
        origin: 'session-manager',
        reason: 'worker-created',
        workerId: 7,
        agent: 'claude',
        workdir: '/tmp/hydra-runtime-worktree',
      }, 'session-manager');
      assert.equal(first.changed, true);
      assert.equal(first.snapshot.state, 'running');

      const duplicate = store.set({
        sessionName: 'repo_worker_runtime',
        state: 'running',
        origin: 'session-manager',
        reason: 'worker-created',
        workerId: 7,
        agent: 'claude',
        workdir: '/tmp/hydra-runtime-worktree',
      }, 'session-manager');
      assert.equal(duplicate.changed, false);

      const changed = store.set({
        sessionName: 'repo_worker_runtime',
        state: 'idle',
        origin: 'notification',
        reason: 'complete',
        notificationId: 'notification-1',
        workerId: 7,
        agent: 'claude',
        workdir: '/tmp/hydra-runtime-worktree',
      }, 'hook');
      assert.equal(changed.changed, true);
      assert.equal(store.get('repo_worker_runtime')?.state, 'idle');

      const events = readEvents(ctx).filter(event => event.type === 'worker.runtime.changed');
      assert.equal(events.length, 2);
      assert.equal(events[0].payload?.state, 'running');
      assert.equal(events[1].payload?.state, 'idle');
      assert.equal(events[1].payload?.previousState, 'running');
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testNotificationProjectionAndReadIsolation(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, () => {
      const store = new NotificationStore();
      const created = store.create({
        kind: 'complete',
        title: 'Worker #7 completed',
        body: 'Task finished',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker_runtime',
        dedupeKey: 'completion:repo_worker_runtime:abc',
        action: { type: 'open-session', session: 'repo_worker_runtime' },
        context: {
          workerId: 7,
          branch: 'issue-233',
          workdir: '/tmp/hydra-runtime-worktree',
          agent: 'claude',
        },
        eventSource: 'hook',
      });
      assert.equal(created.created, true);

      const runtimeStore = new WorkerRuntimeStateStore();
      const snapshot = runtimeStore.get('repo_worker_runtime');
      assertRuntime(snapshot, 'idle', 'complete');
      assert.equal(snapshot?.notificationId, created.notification.id);

      store.markRead(created.notification.id, 'cli');
      assertRuntime(runtimeStore.get('repo_worker_runtime'), 'idle', 'complete');

      store.open(created.notification.id, 'cli');
      assertRuntime(runtimeStore.get('repo_worker_runtime'), 'idle', 'complete');

      fs.rmSync(path.join(ctx.hydraHome, 'worker-runtime-state.json'), { force: true });
      const duplicate = store.create({
        kind: 'complete',
        title: 'Duplicate',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker_runtime',
        dedupeKey: 'completion:repo_worker_runtime:abc',
        eventSource: 'hook',
      });
      assert.equal(duplicate.created, false);
      assertRuntime(runtimeStore.get('repo_worker_runtime'), 'idle', 'complete');

      const eventTypes = readEvents(ctx).map(event => event.type);
      assert.deepEqual(eventTypes, [
        'notify.created',
        'worker.runtime.changed',
        'notify.read',
        'worker.runtime.changed',
      ]);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testNeedsInputWithoutNotificationTargetStillUpdatesRuntime(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, () => {
      const worker = createWorker({ copilotSessionName: null });
      const signal = classifyWorkerNeedsInputEvent({
        agent: 'claude',
        eventName: 'PermissionRequest',
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
      });
      assert.ok(signal);

      const result = publishWorkerNeedsInputNotification(worker, signal, { eventSource: 'hook' });
      assert.equal(result.created, false);
      assert.equal(result.skipped, 'missing-target');
      assert.equal(new NotificationStore().list().notifications.length, 0);
      assertRuntime(new WorkerRuntimeStateStore().get(worker.sessionName), 'needs-input', 'permission-request');
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testMonitorNeedsInputFallbackUsesInjectedRuntimeStore(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, () => {
      const transcript = path.join(ctx.tmp, 'codex-needs-input.jsonl');
      fs.writeFileSync(transcript, [
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-custom-runtime"}}',
        '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-custom-runtime","turn_id":"turn-custom-runtime","questions":[{"question":"Choose an option"}]}}',
      ].join('\n'));

      const worker = createWorker({
        agent: 'codex',
        sessionId: 'codex-custom-runtime',
        agentSessionFile: transcript,
        copilotSessionName: null,
      });
      writeSessions(ctx, worker);

      const customRuntimePath = path.join(ctx.tmp, 'custom-worker-runtime-state.json');
      const customRuntimeStore = new WorkerRuntimeStateStore(
        customRuntimePath,
        new EventLog(
          path.join(ctx.tmp, 'custom-events.jsonl'),
          path.join(ctx.tmp, 'custom-events.state.json'),
        ),
      );
      const monitor = new WorkerNeedsInputMonitor({
        sessionsFile: path.join(ctx.hydraHome, 'sessions.json'),
        runtimeStateStore: customRuntimeStore,
      });
      try {
        monitor.scanOnce();
      } finally {
        monitor.dispose();
      }

      assertRuntime(customRuntimeStore.get(worker.sessionName), 'needs-input', 'request-user-input');
      assert.equal(new WorkerRuntimeStateStore().get(worker.sessionName), undefined);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testCodexTranscriptRuntimeSignals(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, () => {
      const running = classifyCodexRuntimeTranscriptText([
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
      ].join('\n'));
      assert.equal(running?.state, 'running');
      assert.equal(running?.reason, 'task-started');

      const needsInput = classifyCodexRuntimeTranscriptText([
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
        '{"type":"event_msg","payload":{"type":"request_user_input","call_id":"call-1","turn_id":"turn-1","questions":[{"question":"Pick a branch"}]}}',
      ].join('\n'));
      assert.equal(needsInput?.state, 'needs-input');

      const idle = classifyCodexRuntimeTranscriptText([
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}',
        '{"type":"event_msg","payload":{"type":"turn_complete","turn_id":"turn-1"}}',
      ].join('\n'));
      assert.equal(idle?.state, 'idle');

      const transcript = path.join(ctx.tmp, 'codex-session.jsonl');
      fs.writeFileSync(transcript, [
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-monitor"}}',
        '{"type":"event_msg","payload":{"type":"turn_complete","turn_id":"turn-monitor"}}',
      ].join('\n'));
      const worker = createWorker({
        agent: 'codex',
        sessionId: 'codex-session',
        agentSessionFile: transcript,
        copilotSessionName: null,
      });
      writeSessions(ctx, worker);

      const monitor = new WorkerNeedsInputMonitor({
        sessionsFile: path.join(ctx.hydraHome, 'sessions.json'),
      });
      try {
        monitor.scanOnce();
      } finally {
        monitor.dispose();
      }
      assertRuntime(new WorkerRuntimeStateStore().get(worker.sessionName), 'idle', 'turn-complete');
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testListJsonRuntimeState(): Promise<void> {
  if (!fs.existsSync(cliPath)) {
    console.log(`workerRuntimeStateSmoke: skipped list check (CLI not built at ${cliPath})`);
    return;
  }
  if (!tmuxAvailable()) {
    console.log('workerRuntimeStateSmoke: skipped list check (tmux not on PATH)');
    return;
  }

  const ctx = setupContext();
  const tmuxSocket = `hydra-runtime-state-${process.pid}-${Date.now()}`;
  const worker = createWorker({
    sessionName: 'hydra-runtime-list-worker',
    tmuxSession: 'hydra-runtime-list-worker',
    workdir: ctx.tmp,
    copilotSessionName: null,
  });
  try {
    await withProcessEnv(ctx, () => {
      writeSessions(ctx, worker);
      new WorkerRuntimeStateStore().set({
        sessionName: worker.sessionName,
        state: 'needs-input',
        origin: 'hook',
        reason: 'permission-request',
        workerId: worker.workerId,
        agent: worker.agent,
        workdir: worker.workdir,
      }, 'hook');
    });

    spawnSync('tmux', ['-L', tmuxSocket, 'new-session', '-d', '-s', worker.sessionName, '-c', ctx.tmp], {
      stdio: 'ignore',
    });
    const env = {
      ...ctx.env,
      HYDRA_TMUX_SOCKET: tmuxSocket,
    };
    const output = execFileSync(process.execPath, [cliPath, 'list', '--json'], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const list = JSON.parse(output) as { workers: ListWorker[] };
    const listedWorker = list.workers.find(entry => entry.session === worker.sessionName);
    assert.ok(listedWorker, 'expected worker in hydra list output');
    assert.equal(listedWorker!.status, 'running');
    assert.equal(listedWorker!.runtimeState?.state, 'needs-input');
    assert.equal(listedWorker!.runtimeState?.reason, 'permission-request');
  } finally {
    spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

function writeSessions(ctx: TestContext, worker: WorkerInfo): void {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(ctx.hydraHome, 'sessions.json'),
    JSON.stringify({
      copilots: {},
      workers: {
        [worker.sessionName]: worker,
      },
      nextWorkerId: 8,
      updatedAt: now,
    }, null, 2),
  );
}

function assertRuntime(
  snapshot: WorkerRuntimeSnapshot | undefined,
  state: string,
  reason: string,
): void {
  assert.ok(snapshot, `expected runtime state ${state}`);
  assert.equal(snapshot!.state, state);
  assert.equal(snapshot!.reason, reason);
}

function tmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

async function main(): Promise<void> {
  await testStoreEventsAndIdempotency();
  await testNotificationProjectionAndReadIsolation();
  await testNeedsInputWithoutNotificationTargetStillUpdatesRuntime();
  await testMonitorNeedsInputFallbackUsesInjectedRuntimeStore();
  await testCodexTranscriptRuntimeSignals();
  await testListJsonRuntimeState();
  console.log('workerRuntimeStateSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
