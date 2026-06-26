/**
 * Smoke test: extension-host notification state service.
 *
 * Run: node out/smoke/notificationStateServiceSmoke.js
 */

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_OK } from '../cli/output';
import { resolveSessionNotificationClearScope } from '../commands/notificationScope';
import { EventLog } from '../core/events';
import { NotificationStateService } from '../core/notificationStateService';
import {
  NotificationStore,
  type NotificationListFilters,
  type NotificationListResult,
} from '../core/notifications';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

class InitRaceStore extends NotificationStore {
  private injected = false;

  override list(filters: NotificationListFilters = {}): NotificationListResult {
    const result = super.list(filters);
    if (!this.injected) {
      this.injected = true;
      this.create({
        kind: 'info',
        title: 'Created during initialize',
        targetSession: 'race_copilot',
        sourceSession: 'race_worker',
      });
    }
    return result;
  }
}

function setupContext(prefix: string): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
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
    restoreEnv(previous);
  }
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createService(): NotificationStateService {
  return new NotificationStateService({ debounceMs: 5, pollIntervalMs: 50 });
}

function runCli(args: string[], env: Record<string, string | undefined>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseStdoutJson<T>(proc: SpawnSyncReturns<string>, label: string): T {
  assert.equal(proc.status, EXIT_OK, `${label} should exit 0\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  assert.equal(proc.stderr.trim(), '', `${label} should not write stderr`);
  return JSON.parse(proc.stdout) as T;
}

function readEventLines(ctx: TestContext): Array<{ type?: string; source?: string; payload?: { notificationId?: string; readOnly?: boolean } }> {
  const eventsPath = path.join(ctx.hydraHome, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { type?: string; source?: string; payload?: { notificationId?: string } });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testMissingFiles(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-missing-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      try {
        service.initialize();
        assert.equal(service.getUnreadCount(), 0);
        assert.equal(service.getSnapshot().totalCount, 0);
        assert.deepEqual(service.getLatest(), []);
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testInitialLoadAndIndexes(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-initial-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const first = store.create({
        kind: 'complete',
        title: 'Worker completed',
        body: 'Review branch',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'review-diff', session: 'repo_worker' },
        context: { workerId: 7, branch: 'feat/state', workdir: ctx.tmp, agent: 'codex' },
      }).notification;
      const second = store.create({
        kind: 'needs-input',
        title: 'Worker needs input',
        targetSession: 'repo_copilot',
        sourceSession: 'other_worker',
      }).notification;

      const service = createService();
      try {
        service.initialize();
        assert.equal(service.getUnreadCount(), 2);
        assert.equal(service.getSnapshot().totalCount, 2);
        assert.equal(service.getLatest(1)[0].id, second.id);
        assert.equal(service.getById(first.id)?.title, 'Worker completed');
        assert.deepEqual(service.getBySession('repo_worker').map(notification => notification.id), [first.id]);
        assert.deepEqual(service.getByTargetSession('repo_worker').map(notification => notification.id), []);
        assert.deepEqual(service.getBySourceSession('repo_worker').map(notification => notification.id), [first.id]);
        assert.deepEqual(
          service.getBySession('repo_copilot').map(notification => notification.id),
          [second.id, first.id],
        );
        assert.deepEqual(
          service.getByTargetSession('repo_copilot').map(notification => notification.id),
          [second.id, first.id],
        );
        assert.deepEqual(service.getBySourceSession('repo_copilot').map(notification => notification.id), []);

        const snapshot = service.getSnapshot();
        (snapshot.notifications as unknown as { pop(): unknown }).pop();
        assert.equal(service.getSnapshot().totalCount, 2, 'snapshot callers must not mutate service state');
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testServiceOperationsReloadSynchronously(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-ops-');
  try {
    await withProcessEnv(ctx, async () => {
      const created = new NotificationStore().create({
        kind: 'info',
        title: 'Open me',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;
      const service = createService();
      const changes: number[] = [];
      const listener = service.onDidChange(snapshot => changes.push(snapshot.unreadCount));
      try {
        service.initialize();
        assert.equal(service.getUnreadCount(), 1);

        const read = service.markRead(created.id);
        assert.equal(read.markedRead, 1);
        assert.equal(service.getUnreadCount(), 0, 'markRead should update snapshot synchronously');
        assert.deepEqual(changes, [0]);

        await sleep(250);
        assert.deepEqual(changes, [0], 'watchers should not emit a duplicate markRead change');

        const opened = service.open(created.id);
        assert.equal(opened.opened, false);
        assert.equal(opened.action?.type, 'open-session');
        assert.equal(opened.markedRead, 0);
        assert.deepEqual(changes, [0], 'open on an already read notification should not emit content changes');

        const cleared = service.clear({ session: 'repo_worker' });
        assert.equal(cleared.cleared, 1);
        assert.equal(service.getSnapshot().totalCount, 0);
        assert.deepEqual(changes, [0, 0]);
      } finally {
        listener.dispose();
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testTargetSessionOperationsIgnoreSourceOnlyNotifications(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-target-ops-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const sourceOnly = store.create({
        kind: 'complete',
        title: 'Worker completed',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;
      const targeted = store.create({
        kind: 'needs-input',
        title: 'Worker needs input',
        targetSession: 'repo_worker',
        sourceSession: 'repo_copilot',
      }).notification;

      const service = createService();
      try {
        service.initialize();
        assert.deepEqual(service.getByTargetSession('repo_worker').map(notification => notification.id), [targeted.id]);
        assert.deepEqual(service.getBySourceSession('repo_worker').map(notification => notification.id), [sourceOnly.id]);
        assert.equal(service.getLatestSourceAttention('repo_worker')?.id, sourceOnly.id);
        assert.equal(service.getLatestSourceCompletion('repo_worker')?.id, sourceOnly.id);

        const read = service.markTargetSessionRead('repo_worker');
        assert.equal(read.markedRead, 1);
        assert.equal(service.getById(targeted.id)?.readAt !== null, true);
        assert.equal(service.getById(sourceOnly.id)?.readAt, null, 'source-only completion should remain unread for copilot');

        const cleared = service.clear({ targetSession: 'repo_worker' });
        assert.equal(cleared.cleared, 1);
        assert.equal(service.getById(targeted.id), undefined);
        assert.equal(service.getById(sourceOnly.id)?.id, sourceOnly.id);

        const clearedCopilotInbox = service.clear({ targetSession: 'repo_copilot' });
        assert.equal(clearedCopilotInbox.cleared, 1);
        assert.equal(service.getById(sourceOnly.id), undefined);
        assert.equal(service.getLatestSourceAttention('repo_worker'), undefined);
        assert.equal(service.getLatestSourceCompletion('repo_worker'), undefined);
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testWorkerClearScopeClearsSourceNotifications(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-worker-clear-scope-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const completed = store.create({
        kind: 'complete',
        title: 'Worker completed',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;

      const service = createService();
      try {
        service.initialize();
        assert.equal(service.getLatestSourceAttention('repo_worker')?.id, completed.id);
        assert.equal(service.getLatestSourceCompletion('repo_worker')?.id, completed.id);

        const workerScope = resolveSessionNotificationClearScope({ contextValue: 'taskWorkerItem' }, 'repo_worker');
        assert.deepEqual(workerScope.filters, { session: 'repo_worker' });
        assert.equal(service.getBySession('repo_worker').length, 1);
        assert.equal(service.clear(workerScope.filters).cleared, 1);
        assert.equal(service.getLatestSourceAttention('repo_worker'), undefined);
        assert.equal(service.getLatestSourceCompletion('repo_worker'), undefined);

        const copilotScope = resolveSessionNotificationClearScope({ contextValue: 'copilotItem' }, 'repo_copilot');
        assert.deepEqual(copilotScope.filters, { targetSession: 'repo_copilot' });
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testWatcherUpdatesFromNotificationFileOnly(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-file-only-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      try {
        service.initialize();
        const eventsAsDirectory = path.join(ctx.hydraHome, 'events-as-directory');
        fs.mkdirSync(eventsAsDirectory, { recursive: true });
        new NotificationStore(
          path.join(ctx.hydraHome, 'notifications.json'),
          1000,
          new EventLog(eventsAsDirectory, path.join(ctx.hydraHome, 'events-as-directory.state.json')),
        ).create({
          kind: 'info',
          title: 'File-only notification',
          targetSession: 'repo_copilot',
        });

        await waitFor(() => service.getUnreadCount() === 1, 'file-only notification reload');
        assert.equal(service.getLatest(1)[0].title, 'File-only notification');
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testBatchReadAndClearEventSources(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-batch-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const first = store.create({
        kind: 'info',
        title: 'First unread',
        targetSession: 'repo_worker',
      }).notification;
      const second = store.create({
        kind: 'blocked',
        title: 'Second unread',
        sourceSession: 'repo_worker',
      }).notification;
      store.create({
        kind: 'complete',
        title: 'Other unread',
        targetSession: 'other_worker',
      });

      const service = createService();
      try {
        service.initialize();
        assert.equal(service.getUnreadCount(), 3);

        const read = service.markSessionRead('repo_worker', 'extension');
        assert.equal(read.markedRead, 2);
        assert.equal(service.getById(first.id)?.readAt !== null, true);
        assert.equal(service.getById(second.id)?.readAt !== null, true);
        assert.equal(service.getUnreadCount(), 1);

        const readEvents = readEventLines(ctx).filter(event =>
          event.type === 'notify.read' &&
          event.source === 'extension' &&
          (event.payload?.notificationId === first.id || event.payload?.notificationId === second.id)
        );
        assert.equal(readEvents.length, 2, 'batch read should emit one extension notify.read per notification');

        const cleared = service.clearRead({ session: 'repo_worker' }, 'extension');
        assert.equal(cleared.cleared, 2);
        assert.equal(service.getById(first.id), undefined);
        assert.equal(service.getById(second.id), undefined);
        assert.equal(service.getUnreadCount(), 1, 'clearRead should preserve unread notifications');
        const clearEvents = readEventLines(ctx).filter(event =>
          event.type === 'notify.cleared' &&
          event.source === 'extension' &&
          event.payload?.readOnly === true
        );
        assert.equal(clearEvents.length, 1, 'clearRead should emit an extension notify.cleared event');
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testEventOnlyCompletionProjectionEmitsChange(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-event-projection-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      let changes = 0;
      const listener = service.onDidChange(() => { changes += 1; });
      try {
        service.initialize();
        new EventLog().append({
          type: 'notify.created',
          source: 'hook',
          payload: {
            notificationId: 'event-only-complete',
            kind: 'complete',
            targetSession: 'repo_copilot',
            sourceSession: 'repo_worker',
            actionType: 'open-session',
            actionSession: 'repo_worker',
          },
        });

        await waitFor(
          () => service.getLatestSourceCompletion('repo_worker')?.id === 'event-only-complete',
          'event-only completion projection',
        );
        assert.equal(service.getSnapshot().totalCount, 0);
        assert.equal(service.getLatestSourceCompletion('repo_worker')?.action?.session, 'repo_worker');
        assert.ok(changes > 0, 'event-only completion projection should emit a change');
      } finally {
        listener.dispose();
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testEventOnlyClearReadPreservesUnreadProjection(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-event-clear-read-');
  try {
    await withProcessEnv(ctx, async () => {
      const eventLog = new EventLog();
      eventLog.append({
        type: 'notify.created',
        source: 'hook',
        payload: {
          notificationId: 'event-unread-complete',
          kind: 'complete',
          targetSession: 'repo_copilot',
          sourceSession: 'unread_worker',
          actionType: 'open-session',
          actionSession: 'unread_worker',
        },
      });
      eventLog.append({
        type: 'notify.created',
        source: 'hook',
        payload: {
          notificationId: 'event-read-complete',
          kind: 'complete',
          targetSession: 'repo_copilot',
          sourceSession: 'read_worker',
          actionType: 'open-session',
          actionSession: 'read_worker',
        },
      });
      eventLog.append({
        type: 'notify.read',
        source: 'extension',
        payload: {
          notificationId: 'event-read-complete',
        },
      });
      eventLog.append({
        type: 'notify.cleared',
        source: 'extension',
        payload: {
          readOnly: true,
          cleared: 1,
        },
      });

      const service = createService();
      try {
        service.initialize();
        assert.equal(
          service.getLatestSourceAttention('unread_worker')?.id,
          'event-unread-complete',
          'read-only clear must preserve unread event-only source attention',
        );
        assert.equal(
          service.getLatestSourceAttention('read_worker'),
          undefined,
          'read-only clear should remove read event-only source attention',
        );
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testSourceAttentionProjectionUsesLatestStatus(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-source-attention-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const error = store.create({
        kind: 'error',
        title: 'Worker failed during startup',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;
      await sleep(10);
      const complete = store.create({
        kind: 'complete',
        title: 'Worker completed',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;

      const service = createService();
      try {
        service.initialize();
        assert.equal(
          service.getLatestSourceAttention('repo_worker')?.id,
          complete.id,
          'latest source status should override an older higher-priority error',
        );
        assert.equal(service.getLatestSourceAttention('repo_worker')?.kind, 'complete');
        assert.equal(service.getLatestSourceCompletion('repo_worker')?.id, complete.id);

        await sleep(10);
        new EventLog().append({
          type: 'notify.created',
          source: 'cli',
          payload: {
            notificationId: 'event-newer-error',
            kind: 'error',
            title: 'Worker failed after store completion',
            targetSession: 'repo_copilot',
            sourceSession: 'repo_worker',
            actionType: 'open-session',
            actionSession: 'repo_worker',
          },
        });
        await waitFor(
          () => service.getLatestSourceAttention('repo_worker')?.id === 'event-newer-error',
          'event source attention overrides older stored notifications',
        );
        assert.equal(service.getLatestSourceAttention('repo_worker')?.kind, 'error');
        assert.equal(
          service.getLatestSourceCompletion('repo_worker')?.id,
          complete.id,
          'completion compatibility projection should remain available while latest attention is error',
        );

        service.clear({ targetSession: 'repo_copilot' });
        assert.equal(service.getLatestSourceAttention('repo_worker'), undefined);
        assert.equal(service.getLatestSourceCompletion('repo_worker'), undefined);

        await sleep(10);
        const latestComplete = store.create({
          kind: 'complete',
          title: 'Worker completed after error',
          targetSession: 'repo_copilot',
          sourceSession: 'repo_worker',
          action: { type: 'open-session', session: 'repo_worker' },
        }).notification;
        await waitFor(
          () => service.getLatestSourceAttention('repo_worker')?.id === latestComplete.id,
          'latest complete source attention',
        );
        assert.equal(service.getLatestSourceAttention('repo_worker')?.kind, 'complete');
        assert.equal(
          service.getLatestSourceCompletion('repo_worker')?.id,
          latestComplete.id,
          'completion compatibility projection should track latest completion',
        );
        assert.notEqual(error.id, latestComplete.id);
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testEventOnlyErrorProjectionEmitsChange(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-event-error-projection-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      let changes = 0;
      const listener = service.onDidChange(() => { changes += 1; });
      try {
        service.initialize();
        new EventLog().append({
          type: 'notify.created',
          source: 'cli',
          payload: {
            notificationId: 'event-only-error',
            kind: 'error',
            title: 'Worker failed during startup',
            targetSession: 'repo_copilot',
            sourceSession: 'repo_worker',
            actionType: 'open-session',
            actionSession: 'repo_worker',
            workerId: 4,
            branch: 'feat/error',
            workdir: ctx.tmp,
            agent: 'codex',
          },
        });

        await waitFor(
          () => service.getLatestSourceAttention('repo_worker')?.id === 'event-only-error',
          'event-only error projection',
        );
        assert.equal(service.getSnapshot().totalCount, 0);
        const projected = service.getLatestSourceAttention('repo_worker');
        assert.equal(projected?.kind, 'error');
        assert.equal(projected?.title, 'Worker failed during startup');
        assert.equal(projected?.action?.session, 'repo_worker');
        assert.equal(projected?.context?.workerId, 4);
        assert.equal(projected?.context?.workdir, ctx.tmp);
        assert.ok(changes > 0, 'event-only error projection should emit a change');
      } finally {
        listener.dispose();
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testStoredNotificationWinsOverDuplicateEventProjection(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-duplicate-event-projection-');
  try {
    await withProcessEnv(ctx, async () => {
      const store = new NotificationStore();
      const stored = store.create({
        kind: 'error',
        title: 'Worker failed during startup',
        body: 'Full pane missing details remain in notifications.json',
        targetSession: 'repo_copilot',
        sourceSession: 'repo_worker',
        action: { type: 'open-session', session: 'repo_worker' },
      }).notification;

      const service = createService();
      try {
        service.initialize();
        assert.equal(service.getLatestSourceAttention('repo_worker')?.body, stored.body);

        await sleep(10);
        new EventLog().append({
          type: 'notify.created',
          source: 'cli',
          payload: {
            notificationId: stored.id,
            kind: 'error',
            title: 'Event projection should not replace store title',
            body: 'Event body is redacted by the event sanitizer',
            targetSession: 'repo_copilot',
            sourceSession: 'repo_worker',
            actionType: 'open-session',
            actionSession: 'repo_worker',
          },
        });

        service.markRead(stored.id);
        const projected = service.getLatestSourceAttention('repo_worker');
        assert.equal(projected?.id, stored.id);
        assert.equal(projected?.title, stored.title);
        assert.equal(projected?.body, stored.body);
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testInitializeSignatureWindow(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-init-window-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = new NotificationStateService({
        debounceMs: 5,
        pollIntervalMs: 50,
        store: new InitRaceStore(),
      });
      try {
        service.initialize();
        assert.equal(service.getUnreadCount(), 1);
        assert.equal(service.getLatest(1)[0].title, 'Created during initialize');
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testDuplicateAndMalformedEventTolerance(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-events-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      try {
        service.initialize();
        const store = new NotificationStore();
        const first = store.create({
          kind: 'info',
          title: 'Dedupe source',
          targetSession: 'repo_copilot',
          dedupeKey: 'dedupe:one',
        }).notification;
        store.create({
          kind: 'info',
          title: 'Should not appear',
          targetSession: 'repo_copilot',
          dedupeKey: 'dedupe:one',
        });

        await waitFor(() => service.getSnapshot().totalCount === 1, 'deduped notification reload');
        assert.equal(service.getLatest(1)[0].id, first.id);

        const eventsPath = path.join(ctx.hydraHome, 'events.jsonl');
        fs.appendFileSync(eventsPath, '{"version":1,"seq":99,"bootId":"partial"\n', 'utf-8');
        await sleep(150);
        assert.equal(service.getSnapshot().totalCount, 1, 'partial event tail should be tolerated');

        fs.appendFileSync(
          eventsPath,
          `{"version":1,"seq":100,"bootId":"manual","ts":"${new Date().toISOString()}","type":"notify.created","source":"cli"}\n`,
          'utf-8',
        );
        fs.writeFileSync(
          path.join(ctx.hydraHome, 'notifications.json'),
          `${JSON.stringify({
            version: 1,
            notifications: [{
              id: 'manual-notification',
              createdAt: new Date().toISOString(),
              readAt: null,
              kind: 'info',
              title: 'Manual fallback notification',
              body: '',
              targetSession: 'repo_copilot',
              sourceSession: null,
            }],
          }, null, 2)}\n`,
          'utf-8',
        );

        await waitFor(
          () => service.getById('manual-notification')?.title === 'Manual fallback notification',
          'malformed event fallback reload',
        );
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testCliEndToEnd(): Promise<void> {
  if (!fs.existsSync(cliPath)) {
    console.log(`notificationStateServiceSmoke: skipped CLI E2E (CLI not built at ${cliPath})`);
    return;
  }

  const ctx = setupContext('hydra-notification-state-cli-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      try {
        service.initialize();
        const created = parseStdoutJson<{ notification: { id: string } }>(
          runCli([
            'notify',
            'create',
            '--session',
            'repo_copilot',
            '--from',
            'repo_worker',
            '--kind',
            'complete',
            '--title',
            'CLI worker completed',
            '--json',
          ], ctx.env),
          'hydra notify create --json',
        );
        await waitFor(() => service.getById(created.notification.id) !== undefined, 'CLI create reflected in service');
        assert.equal(service.getUnreadCount(), 1);
        assert.equal(service.getBySession('repo_worker')[0].id, created.notification.id);
        assert.equal(service.getByTargetSession('repo_copilot')[0].id, created.notification.id);
        assert.equal(service.getBySourceSession('repo_worker')[0].id, created.notification.id);

        parseStdoutJson<{ markedRead: number }>(
          runCli(['notify', 'read', created.notification.id, '--json'], ctx.env),
          'hydra notify read --json',
        );
        await waitFor(() => service.getUnreadCount() === 0, 'CLI read reflected in service');

        parseStdoutJson<{ cleared: number }>(
          runCli(['notify', 'clear', '--session', 'repo_worker', '--json'], ctx.env),
          'hydra notify clear --json',
        );
        await waitFor(() => service.getSnapshot().totalCount === 0, 'CLI clear reflected in service');
        assert.equal(service.getLatestSourceAttention('repo_worker'), undefined);
        assert.equal(service.getLatestSourceCompletion('repo_worker'), undefined);
      } finally {
        service.dispose();
      }
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function testDisposeStopsWatchers(): Promise<void> {
  const ctx = setupContext('hydra-notification-state-dispose-');
  try {
    await withProcessEnv(ctx, async () => {
      const service = createService();
      let changes = 0;
      service.onDidChange(() => { changes += 1; });
      service.initialize();
      service.dispose();
      new NotificationStore().create({
        kind: 'info',
        title: 'After dispose',
        targetSession: 'repo_copilot',
      });
      await sleep(200);
      assert.equal(changes, 0);
      assert.equal(service.getSnapshot().totalCount, 0);
    });
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testMissingFiles();
  await testInitialLoadAndIndexes();
  await testServiceOperationsReloadSynchronously();
  await testTargetSessionOperationsIgnoreSourceOnlyNotifications();
  await testWorkerClearScopeClearsSourceNotifications();
  await testWatcherUpdatesFromNotificationFileOnly();
  await testBatchReadAndClearEventSources();
  await testEventOnlyCompletionProjectionEmitsChange();
  await testEventOnlyClearReadPreservesUnreadProjection();
  await testSourceAttentionProjectionUsesLatestStatus();
  await testEventOnlyErrorProjectionEmitsChange();
  await testStoredNotificationWinsOverDuplicateEventProjection();
  await testInitializeSignatureWindow();
  await testDuplicateAndMalformedEventTolerance();
  await testCliEndToEnd();
  await testDisposeStopsWatchers();
  console.log('notificationStateServiceSmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
