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
        assert.deepEqual(
          service.getBySession('repo_copilot').map(notification => notification.id),
          [second.id, first.id],
        );

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
  await testWatcherUpdatesFromNotificationFileOnly();
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
