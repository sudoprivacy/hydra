/**
 * Smoke test: worker attention notification publisher.
 *
 * Run: node out/smoke/workerAttentionNotificationSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotificationStore } from '../core/notifications';
import type { WorkerInfo } from '../core/sessionManager';
import {
  awaitWorkerPostCreateOrPublishError,
  classifyRuntimeErrorReason,
  publishWorkerAttentionNotification,
  publishWorkerRuntimeErrorNotification,
} from '../core/workerAttentionNotifications';

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
}

class FailingNotificationStore extends NotificationStore {
  override create(): never {
    throw new Error('simulated notification store failure');
  }
}

function setupContext(): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-attention-'));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
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
    sessionName: 'repo_worker_feat_error',
    displayName: 'feat/error',
    workerId: 4,
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: 'feat/error',
    slug: 'feat-error',
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir: '/tmp/hydra-worktree',
    tmuxSession: 'repo_worker_feat_error',
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName: 'repo_copilot',
    ...overrides,
  };
}

function readEvents(ctx: TestContext): Array<{ type?: string; source?: string; payload?: Record<string, unknown> }> {
  const eventsPath = path.join(ctx.hydraHome, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: string; source?: string; payload?: Record<string, unknown> });
}

async function testRuntimeErrorNotification(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const worker = createWorker();
      const error = new Error('Initial prompt delivery failed for "repo_worker_feat_error": pane missing');

      const first = publishWorkerRuntimeErrorNotification(worker, error, { eventSource: 'cli' });
      assert.equal(first.created, true);
      assert.equal(first.notification.kind, 'error');
      assert.equal(first.notification.targetSession, 'repo_copilot');
      assert.equal(first.notification.sourceSession, worker.sessionName);
      assert.equal(first.notification.action?.type, 'open-session');
      assert.equal(first.notification.action?.session, worker.sessionName);
      assert.equal(first.notification.context?.workerId, 4);
      assert.equal(first.notification.context?.branch, 'feat/error');
      assert.equal(first.notification.context?.workdir, '/tmp/hydra-worktree');
      assert.equal(first.notification.context?.agent, 'codex');
      assert.match(first.notification.title, /failed to receive its initial task/);
      assert.match(first.notification.body, /pane missing/);
      assert.match(first.notification.dedupeKey || '', /^worker-error:repo_worker_feat_error:initial-prompt:/);

      const duplicate = publishWorkerRuntimeErrorNotification(worker, error, { eventSource: 'cli' });
      assert.equal(duplicate.created, false);
      assert.ok(duplicate.notification);
      assert.equal(duplicate.notification.id, first.notification.id);

      const stored = new NotificationStore().list().notifications;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].id, first.notification.id);

      const events = readEvents(ctx).filter(event => event.type === 'notify.created');
      assert.equal(events.length, 1);
      assert.equal(events[0].source, 'cli');
      assert.equal(events[0].payload?.notificationId, first.notification.id);
      assert.equal(events[0].payload?.kind, 'error');
      assert.equal(events[0].payload?.targetSession, 'repo_copilot');
      assert.equal(events[0].payload?.sourceSession, worker.sessionName);
      assert.equal(events[0].payload?.actionType, 'open-session');
      assert.equal(events[0].payload?.actionSession, worker.sessionName);
      assert.equal(events[0].payload?.workerId, 4);
      assert.equal(events[0].payload?.branch, 'feat/error');
      assert.equal(events[0].payload?.workdir, '/tmp/hydra-worktree');
      assert.equal(events[0].payload?.agent, 'codex');

      assert.equal(classifyRuntimeErrorReason(error), 'initial-prompt');
      assert.equal(
        classifyRuntimeErrorReason(new Error('Timed out waiting for worker startup for "repo_worker" after 100ms')),
        'startup-timeout',
      );
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testMissingCopilotUsesGlobalInbox(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const global = publishWorkerRuntimeErrorNotification(
        createWorker({ copilotSessionName: null }),
        new Error('Initial prompt delivery failed'),
      );
      assert.equal(global.created, true);
      assert.equal(global.notification.targetSession, null);
      assert.equal(global.notification.kind, 'error');
      assert.equal(new NotificationStore().list().notifications.length, 1);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testStoreFailureDoesNotThrow(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const result = publishWorkerAttentionNotification({
        kind: 'error',
        targetCopilotSession: 'repo_copilot',
        sourceWorkerSession: 'repo_worker',
        title: 'Worker failed',
        store: new FailingNotificationStore(),
      });
      assert.equal(result.created, false);
      assert.equal(result.skipped, 'store-failed');
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testPostCreateHelperPublishesAndRethrows(): Promise<void> {
  const ctx = setupContext();
  try {
    await withProcessEnv(ctx, async () => {
      const worker = createWorker({ sessionName: 'repo_worker_start_failed' });
      const error = new Error('Timed out waiting for worker startup for "repo_worker_start_failed" after 30000ms');

      await assert.rejects(
        () => awaitWorkerPostCreateOrPublishError(worker, Promise.reject(error), { eventSource: 'cli' }),
        /Timed out waiting for worker startup/,
      );

      const stored = new NotificationStore().list().notifications;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].kind, 'error');
      assert.equal(stored[0].sourceSession, worker.sessionName);
      assert.equal(stored[0].targetSession, worker.copilotSessionName);
      assert.match(stored[0].title, /failed during startup/);
      assert.match(stored[0].dedupeKey || '', /^worker-error:repo_worker_start_failed:startup-timeout:/);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testRuntimeErrorNotification();
  await testMissingCopilotUsesGlobalInbox();
  await testStoreFailureDoesNotThrow();
  await testPostCreateHelperPublishesAndRethrows();
  console.log('workerAttentionNotificationSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
