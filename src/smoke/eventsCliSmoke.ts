/**
 * Smoke test: Hydra local JSONL event stream and CLI reader.
 *
 * Run: node out/smoke/eventsCliSmoke.js
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { EXIT_OK } from '../cli/output';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

interface EventRecord {
  version: number;
  seq: number;
  bootId: string;
  ts: string;
  type: string;
  source: string;
  session?: string;
  payload?: Record<string, unknown>;
}

function setupContext(): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-events-cli-'));
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

async function main(): Promise<void> {
  if (!fs.existsSync(cliPath)) {
    console.log(`eventsCliSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const ctx = setupContext();
  try {
    const secretBody = 'secret body should not leak into events';
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
        'Worker #9 completed',
        '--body',
        secretBody,
        '--dedupe-key',
        'completion:repo_worker:events-a',
        '--json',
      ], ctx.env),
      'hydra notify create --json',
    );

    const duplicate = parseStdoutJson<{ status: string; created: boolean }>(
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
        'Duplicate should not emit',
        '--dedupe-key',
        'completion:repo_worker:events-a',
        '--json',
      ], ctx.env),
      'hydra notify create duplicate --json',
    );
    assert.equal(duplicate.status, 'exists');
    assert.equal(duplicate.created, false);

    const allAfterCreate = parseStdoutJson<{ status: string; events: EventRecord[]; count: number; lastSeq: number }>(
      runCli(['events', '--json'], ctx.env),
      'hydra events --json',
    );
    assert.equal(allAfterCreate.status, 'ok');
    assert.equal(allAfterCreate.count, 1);
    assert.equal(allAfterCreate.events[0].type, 'notify.created');
    assert.equal(allAfterCreate.events[0].source, 'cli');
    assert.equal(allAfterCreate.events[0].seq, 1);
    assert.equal(allAfterCreate.lastSeq, 1);

    parseStdoutJson<{ markedRead: number }>(
      runCli(['notify', 'read', created.notification.id, '--json'], ctx.env),
      'hydra notify read --json',
    );

    const afterOne = parseStdoutJson<{ events: EventRecord[]; count: number; lastSeq: number }>(
      runCli(['events', '--after', '1', '--json'], ctx.env),
      'hydra events --after 1 --json',
    );
    assert.equal(afterOne.count, 1);
    assert.equal(afterOne.events[0].seq, 2);
    assert.equal(afterOne.events[0].type, 'notify.read');
    assert.equal(afterOne.lastSeq, 2);

    const cursorFile = path.join(ctx.tmp, 'events.seq');
    const cursorRead = parseStdoutJson<{ events: EventRecord[]; count: number; lastSeq: number }>(
      runCli(['events', '--cursor-file', cursorFile, '--json'], ctx.env),
      'hydra events --cursor-file --json',
    );
    assert.equal(cursorRead.count, 2);
    assert.equal(cursorRead.lastSeq, 2);
    assert.equal(fs.readFileSync(cursorFile, 'utf-8').trim(), '2');

    const otherBody = 'another body should also stay out of events';
    parseStdoutJson<{ notification: { id: string } }>(
      runCli([
        'notify',
        'create',
        '--session',
        'repo_copilot',
        '--from',
        'repo_worker',
        '--kind',
        'info',
        '--title',
        'Second event',
        '--body',
        otherBody,
        '--json',
      ], ctx.env),
      'hydra notify create second --json',
    );

    const cursorNext = parseStdoutJson<{ events: EventRecord[]; count: number; lastSeq: number }>(
      runCli(['events', '--cursor-file', cursorFile, '--json'], ctx.env),
      'hydra events --cursor-file next --json',
    );
    assert.equal(cursorNext.count, 1);
    assert.equal(cursorNext.events[0].seq, 3);
    assert.equal(cursorNext.events[0].type, 'notify.created');
    assert.equal(cursorNext.lastSeq, 3);
    assert.equal(fs.readFileSync(cursorFile, 'utf-8').trim(), '3');

    const eventLogPath = path.join(ctx.hydraHome, 'events.jsonl');
    const followCursor = path.join(ctx.tmp, 'follow.seq');
    const follow = spawn(process.execPath, [
      cliPath,
      'events',
      '--after',
      '3',
      '--follow',
      '--cursor-file',
      followCursor,
      '--json',
    ], {
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const nextEvent = waitForJsonLine(follow);
      await sleep(300);
      parseStdoutJson<{ cleared: number }>(
        runCli(['notify', 'clear', '--session', 'repo_worker', '--json'], ctx.env),
        'hydra notify clear --json',
      );
      const followed = await nextEvent;
      assert.equal(followed.seq, 4);
      assert.equal(followed.type, 'notify.cleared');
      await waitForFileContent(followCursor, '4');
    } finally {
      await stopProcess(follow);
    }

    const partialFollow = spawn(process.execPath, [
      cliPath,
      'events',
      '--after',
      '4',
      '--follow',
      '--json',
    ], {
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const nextEvent = waitForJsonLine(partialFollow);
      await sleep(300);
      fs.appendFileSync(
        eventLogPath,
        `{"version":1,"seq":5,"bootId":"manual","ts":"${new Date().toISOString()}","type":"manual.partial","source":"cli"`,
        'utf-8',
      );
      await sleep(400);
      fs.appendFileSync(eventLogPath, '}\n', 'utf-8');
      const completed = await nextEvent;
      assert.equal(completed.seq, 5);
      assert.equal(completed.type, 'manual.partial');
    } finally {
      await stopProcess(partialFollow);
    }

    const eventLogRaw = fs.readFileSync(eventLogPath, 'utf-8');
    assert.equal(eventLogRaw.includes(secretBody), false, 'events.jsonl must not include notification body');
    assert.equal(eventLogRaw.includes(otherBody), false, 'events.jsonl must not include notification body');
    assert.match(eventLogRaw, /"type":"notify\.created"/);

    console.log('eventsCliSmoke: ok');
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

function waitForJsonLine(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<EventRecord> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for hydra events --follow\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 8000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      const line = stdout.split(/\r?\n/).find(candidate => candidate.trim().length > 0);
      if (!line) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line) as EventRecord);
      } catch (error) {
        reject(error);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on('exit', (code, signal) => {
      if (!stdout.trim()) {
        clearTimeout(timeout);
        reject(new Error(`hydra events --follow exited before output code=${code} signal=${signal}\nstderr:\n${stderr}`));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFileContent(filePath: string, expected: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8').trim() === expected) {
      return;
    }
    await sleep(50);
  }
  const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').trim() : '<missing>';
  assert.equal(actual, expected);
}

async function stopProcess(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
