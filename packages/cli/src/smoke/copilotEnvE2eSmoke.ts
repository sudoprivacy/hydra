/**
 * E2E smoke for HYDRA_COPILOT_SESSION parent detection.
 *
 * Runs the real CLI against an isolated HYDRA_HOME and tmux socket. Two
 * copilots share the same workdir; one fake copilot invokes `hydra worker
 * create` from a child process with TMUX unset but HYDRA_COPILOT_SESSION
 * inherited. The worker must bind to that copilot, and the copilot env must
 * not leak into the worker agent process.
 */

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HYDRA_COPILOT_SESSION_ENV } from '@hydra/core/env';

interface WorkerEntry {
  sessionName?: string;
  workerId?: number;
  branch?: string;
  workdir?: string;
  copilotSessionName?: string | null;
}

interface SessionState {
  workers?: Record<string, WorkerEntry>;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

type ProcessEnv = Record<string, string | undefined>;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const COPILOT_A = 'hydra-env-e2e-copilot-a';
const COPILOT_B = 'hydra-env-e2e-copilot-b';
const WORKER_BRANCH = 'test-copilot-env-e2e';

function which(cmd: string): string | null {
  const result = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function skip(reason: string): never {
  console.log(`copilotEnvE2eSmoke: SKIP (${reason})`);
  process.exit(0);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(command: string, args: string[], env: ProcessEnv, cwd?: string, timeout = 90_000): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function assertRun(label: string, result: RunResult): void {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (status=${result.status})\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  condition: () => T | false | null | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function writeFakeCodex(filePath: string): void {
  writeExecutable(filePath, [
    '#!/bin/sh',
    'set -eu',
    'LOG=${HYDRA_FAKE_AGENT_LOG:?}',
    `SESSION=\${${HYDRA_COPILOT_SESSION_ENV}:-}`,
    'printf "START cwd=%s hydra_copilot_session=%s args=%s\\n" "$PWD" "$SESSION" "$*" >> "$LOG"',
    `printf 'Session: ${SESSION_ID}\\n\\342\\200\\272\\n'`,
    'while IFS= read -r line; do',
    '  printf "INPUT cwd=%s hydra_copilot_session=%s line=%s\\n" "$PWD" "$SESSION" "$line" >> "$LOG"',
    '  case "$line" in',
    "    CREATE_WORKER'|'*)",
    '      rest=${line#CREATE_WORKER|}',
    '      repo=${rest%%|*}',
    '      branch=${rest#*|}',
    '      printf "RUN_WORKER hydra_copilot_session=%s repo=%s branch=%s\\n" "$SESSION" "$repo" "$branch" >> "$LOG"',
    '      set +e',
    '      env -u TMUX -u TMUX_PANE hydra --json worker create --repo "$repo" --branch "$branch" --agent codex --task "complete from fake agent" >> "$LOG" 2>&1',
    '      status=$?',
    '      set -e',
    '      printf "DONE_WORKER hydra_copilot_session=%s branch=%s status=%s\\n" "$SESSION" "$branch" "$status" >> "$LOG"',
    '      ;;',
    '    /status)',
    `      printf 'Session: ${SESSION_ID}\\n\\342\\200\\272\\n'`,
    '      ;;',
    '    *)',
    "      printf '\\342\\200\\272\\n'",
    '      ;;',
    '  esac',
    'done',
    '',
  ].join('\n'));
}

if (process.platform === 'win32') {
  skip('Windows is not supported by this smoke');
}
if (!which('tmux')) {
  skip('tmux is not on PATH');
}
if (!which('git')) {
  skip('git is not on PATH');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-copilot-env-e2e-'));
const homeDir = path.join(tempRoot, 'home');
const hydraHome = path.join(homeDir, '.hydra');
const hydraConfigPath = path.join(tempRoot, 'config.json');
const repoRoot = path.join(tempRoot, 'repo');
const tmuxDir = path.join(tempRoot, 'tmux');
const tmuxSocket = path.join(tmuxDir, 'hydra.sock');
const binDir = path.join(tempRoot, 'bin');
const fakeAgentLog = path.join(tempRoot, 'fake-agent.log');
const cliEntry = path.resolve(__dirname, '..', 'cli', 'index.js');

const childEnv: ProcessEnv = {
  ...process.env,
  HOME: homeDir,
  HYDRA_HOME: hydraHome,
  HYDRA_CONFIG_PATH: hydraConfigPath,
  HYDRA_TMUX_SOCKET: tmuxSocket,
  HYDRA_FAKE_AGENT_LOG: fakeAgentLog,
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
  GIT_AUTHOR_NAME: 'hydra-copilot-env-e2e',
  GIT_AUTHOR_EMAIL: 'hydra-copilot-env-e2e@example.com',
  GIT_COMMITTER_NAME: 'hydra-copilot-env-e2e',
  GIT_COMMITTER_EMAIL: 'hydra-copilot-env-e2e@example.com',
};
delete childEnv.TMUX;
delete childEnv.TMUX_PANE;
delete childEnv[HYDRA_COPILOT_SESSION_ENV];

function runHydra(args: string[]): RunResult {
  return run(process.execPath, [cliEntry, '--json', ...args], childEnv, repoRoot);
}

function runTmux(args: string[]): RunResult {
  return run('tmux', ['-S', tmuxSocket, ...args], childEnv, repoRoot);
}

function readSessions(): SessionState {
  const sessionsFile = path.join(hydraHome, 'sessions.json');
  return fs.existsSync(sessionsFile) ? readJson<SessionState>(sessionsFile) : {};
}

function readFakeAgentLog(): string {
  return fs.existsSync(fakeAgentLog) ? fs.readFileSync(fakeAgentLog, 'utf-8') : '';
}

async function main(): Promise<void> {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(path.join(binDir, 'hydra'), [
    '#!/bin/sh',
    'set -eu',
    `exec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} "$@"`,
    '',
  ].join('\n'));
  writeFakeCodex(path.join(binDir, 'codex'));

  execSync('git init -b main', { cwd: repoRoot, env: childEnv, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoRoot, env: childEnv, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: repoRoot, env: childEnv, stdio: 'pipe' });

  try {
    assertRun('copilot A create', runHydra([
      'copilot', 'create',
      '--agent', 'codex',
      '--workdir', repoRoot,
      '--session', COPILOT_A,
    ]));
    assertRun('copilot B create', runHydra([
      'copilot', 'create',
      '--agent', 'codex',
      '--workdir', repoRoot,
      '--session', COPILOT_B,
    ]));

    assertRun(
      'send create command to copilot B',
      runTmux(['send-keys', '-t', COPILOT_B, `CREATE_WORKER|${repoRoot}|${WORKER_BRANCH}`, 'Enter']),
    );

    const worker = await pollUntil(() => {
      const workers = readSessions().workers || {};
      return Object.entries(workers).find(([, value]) => value.branch === WORKER_BRANCH) || null;
    }, 60_000, 'worker created by copilot B');

    const [workerSessionName, workerInfo] = worker;
    assert.equal(workerInfo.copilotSessionName, COPILOT_B);
    assert.ok(workerInfo.workdir, 'worker workdir should be recorded');

    const workerStartPattern = new RegExp(
      `START cwd=${escapeRegExp(workerInfo.workdir)} hydra_copilot_session= args=`,
    );
    const log = await pollUntil(() => {
      const currentLog = readFakeAgentLog();
      return workerStartPattern.test(currentLog) ? currentLog : null;
    }, 60_000, 'worker agent start log without copilot env');
    assert.match(
      log,
      new RegExp(`START cwd=${escapeRegExp(repoRoot)} hydra_copilot_session=${COPILOT_A}`),
      'copilot A should launch with its own HYDRA_COPILOT_SESSION',
    );
    assert.match(
      log,
      new RegExp(`START cwd=${escapeRegExp(repoRoot)} hydra_copilot_session=${COPILOT_B}`),
      'copilot B should launch with its own HYDRA_COPILOT_SESSION',
    );
    assert.match(
      log,
      new RegExp(`RUN_WORKER hydra_copilot_session=${COPILOT_B} repo=.* branch=${WORKER_BRANCH}`),
      'worker create should be invoked from copilot B process env',
    );
    assert.match(
      log,
      workerStartPattern,
      'worker agent should not inherit HYDRA_COPILOT_SESSION',
    );

    const notifyScript = path.join(hydraHome, 'hooks', `notify-${workerSessionName}.sh`);
    const pendingPath = path.join(hydraHome, 'hooks', `notify-${workerSessionName}.pending`);
    assert.ok(fs.existsSync(notifyScript), 'notify hook script should be generated');
    await pollUntil(() => fs.existsSync(pendingPath), 60_000, 'notify pending marker to be armed');
    assert.match(fs.readFileSync(notifyScript, 'utf-8'), new RegExp(`COPILOT='${COPILOT_B}'`));

    assertRun('run notify script', run('sh', [notifyScript], childEnv, repoRoot));
    await pollUntil(() => {
      const currentLog = fs.readFileSync(fakeAgentLog, 'utf-8');
      return currentLog.includes(`INPUT cwd=${repoRoot} hydra_copilot_session=${COPILOT_B} line=Worker #`);
    }, 10_000, 'completion notification delivered to copilot B');

    const finalLog = fs.readFileSync(fakeAgentLog, 'utf-8');
    assert.equal(
      finalLog.includes(`INPUT cwd=${repoRoot} hydra_copilot_session=${COPILOT_A} line=Worker #`),
      false,
      'completion notification should not be delivered to copilot A',
    );
    assert.equal(fs.existsSync(pendingPath), false, 'notify pending marker should be consumed');

    assertRun('worker delete', runHydra(['worker', 'delete', workerSessionName]));
    assertRun('copilot B delete', runHydra(['copilot', 'delete', COPILOT_B]));
    assertRun('copilot A delete', runHydra(['copilot', 'delete', COPILOT_A]));

    console.log('copilotEnvE2eSmoke: ok');
  } finally {
    runTmux(['kill-server']);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  try { runTmux(['kill-server']); } catch { /* best-effort */ }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
