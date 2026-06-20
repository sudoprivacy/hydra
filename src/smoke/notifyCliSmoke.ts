/**
 * Smoke test: structured notification CLI and local store.
 *
 * Run: node out/smoke/notifyCliSmoke.js
 */

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_OK } from '../cli/output';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

function setupContext(): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-notify-cli-'));
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

function main(): void {
  if (!fs.existsSync(cliPath)) {
    console.log(`notifyCliSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const ctx = setupContext();
  try {
    const created = parseStdoutJson<{
      status: string;
      created: boolean;
      notification: {
        id: string;
        kind: string;
        title: string;
        body: string;
        targetSession: string | null;
        sourceSession: string | null;
        readAt: string | null;
        dedupeKey?: string;
        action?: { type: string; session: string };
      };
    }>(
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
        'Worker #7 completed',
        '--body',
        'Branch: feat/auth',
        '--dedupe-key',
        'completion:repo_worker:abc',
        '--action',
        'open-session',
        '--action-session',
        'repo_worker',
        '--worker-id',
        '7',
        '--branch',
        'feat/auth',
        '--workdir',
        ctx.tmp,
        '--agent',
        'codex',
        '--json',
      ], ctx.env),
      'hydra notify create --json',
    );
    assert.equal(created.status, 'created');
    assert.equal(created.created, true);
    assert.equal(created.notification.kind, 'complete');
    assert.equal(created.notification.targetSession, 'repo_copilot');
    assert.equal(created.notification.sourceSession, 'repo_worker');
    assert.equal(created.notification.readAt, null);
    assert.equal(created.notification.action?.type, 'open-session');
    assert.equal(created.notification.action?.session, 'repo_worker');

    const duplicate = parseStdoutJson<typeof created>(
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
        'Duplicate should not append',
        '--dedupe-key',
        'completion:repo_worker:abc',
        '--json',
      ], ctx.env),
      'hydra notify create duplicate --json',
    );
    assert.equal(duplicate.status, 'exists');
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.notification.id, created.notification.id);
    assert.equal(duplicate.notification.title, created.notification.title);

    const list = parseStdoutJson<{
      status: string;
      notifications: Array<{ id: string; readAt: string | null }>;
      count: number;
      unreadCount: number;
      totalCount: number;
    }>(
      runCli(['notify', 'list', '--session', 'repo_worker', '--unread', '--json'], ctx.env),
      'hydra notify list --json',
    );
    assert.equal(list.status, 'ok');
    assert.equal(list.count, 1);
    assert.equal(list.unreadCount, 1);
    assert.equal(list.totalCount, 1);
    assert.equal(list.notifications[0].id, created.notification.id);

    const read = parseStdoutJson<{
      status: string;
      notification: { id: string; readAt: string | null };
      markedRead: number;
    }>(
      runCli(['notify', 'read', created.notification.id, '--json'], ctx.env),
      'hydra notify read --json',
    );
    assert.equal(read.status, 'ok');
    assert.equal(read.notification.id, created.notification.id);
    assert.equal(read.markedRead, 1);
    assert.ok(read.notification.readAt, 'readAt should be set');

    const opened = parseStdoutJson<{
      status: string;
      opened: boolean;
      notification: { id: string; readAt: string | null };
      action: { type: string; session: string } | null;
      markedRead: number;
    }>(
      runCli(['notify', 'open', created.notification.id, '--json'], ctx.env),
      'hydra notify open --json',
    );
    assert.equal(opened.status, 'ok');
    assert.equal(opened.opened, false);
    assert.equal(opened.notification.id, created.notification.id);
    assert.equal(opened.action?.type, 'open-session');
    assert.equal(opened.action?.session, 'repo_worker');
    assert.equal(opened.markedRead, 0);

    const storePath = path.join(ctx.hydraHome, 'notifications.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as { version: number; notifications: unknown[] };
    assert.equal(store.version, 1);
    assert.equal(store.notifications.length, 1);

    const cleared = parseStdoutJson<{ status: string; cleared: number }>(
      runCli(['notify', 'clear', '--session', 'repo_worker', '--json'], ctx.env),
      'hydra notify clear --json',
    );
    assert.equal(cleared.status, 'ok');
    assert.equal(cleared.cleared, 1);

    const emptyList = parseStdoutJson<{ notifications: unknown[]; count: number; unreadCount: number; totalCount: number }>(
      runCli(['notify', 'list', '--json'], ctx.env),
      'hydra notify list empty --json',
    );
    assert.equal(emptyList.count, 0);
    assert.equal(emptyList.unreadCount, 0);
    assert.equal(emptyList.totalCount, 0);

    console.log('notifyCliSmoke: ok');
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

main();
