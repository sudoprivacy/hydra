/**
 * E2E smoke: telemetry capture sites fire through real CLI commands.
 *
 * Spawns a fully isolated environment (HYDRA_HOME, HYDRA_TMUX_SOCKET, HOME,
 * PATH) and runs the actual `hydra` CLI binary for:
 *
 *   1. copilot create
 *   2. worker create
 *   3. worker delete
 *   4. copilot delete
 *
 * Then asserts ~/.hydra/telemetry.log contains exactly those four events
 * (in that order), with auto-attached props and a normalized agent name.
 *
 * SKIPs (exit 0) when tmux/git are missing or on Windows — matches the
 * resilience pattern in the other smokes.
 *
 * Run:  node out/smoke/telemetryE2eSmoke.js
 */

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CapturedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function skip(reason: string): never {
  console.log(`telemetryE2eSmoke: SKIP (${reason})`);
  process.exit(0);
}

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

if (process.platform === 'win32') {
  skip('Windows is not supported by this smoke (POSIX-only paths/perms)');
}
if (!which('tmux')) {
  skip('tmux is not on PATH');
}
if (!which('git')) {
  skip('git is not on PATH');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-telem-e2e-'));
const homeDir = path.join(tempRoot, 'home');
const hydraHome = path.join(homeDir, '.hydra');
const repoRoot = path.join(tempRoot, 'repo');
const tmuxDir = path.join(tempRoot, 'tmux');
const tmuxSocket = path.join(tmuxDir, 'hydra.sock');
const stubBinDir = path.join(tempRoot, 'bin');
const cliEntry = path.resolve(__dirname, '..', 'cli', 'index.js');
const STUB_AGENT_NAME = 'hydra-telem-stub-agent';

let failure: unknown = null;
let capturedEvents: CapturedEvent[] = [];

async function main(): Promise<void> {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  fs.mkdirSync(stubBinDir, { recursive: true });

  // Non-allowlisted agent name so normalizeAgentForTelemetry → "custom".
  // The script must keep the tmux pane alive so worker/copilot create
  // do not race with a dead pane during agent-readiness waits.
  const stubAgent = path.join(stubBinDir, STUB_AGENT_NAME);
  fs.writeFileSync(stubAgent, '#!/bin/sh\nexec tail -f /dev/null\n');
  fs.chmodSync(stubAgent, 0o755);

  const childEnv = {
    ...process.env,
    HOME: homeDir,
    HYDRA_HOME: hydraHome,
    HYDRA_TMUX_SOCKET: tmuxSocket,
    HYDRA_TELEMETRY_DEBUG: '1',
    HYDRA_TELEMETRY: '',
    PATH: `${stubBinDir}:${process.env.PATH ?? ''}`,
    GIT_AUTHOR_NAME: 'hydra-telem-e2e',
    GIT_AUTHOR_EMAIL: 'hydra-telem-e2e@example.com',
    GIT_COMMITTER_NAME: 'hydra-telem-e2e',
    GIT_COMMITTER_EMAIL: 'hydra-telem-e2e@example.com',
  };

  const gitOpts = { cwd: repoRoot, env: childEnv, stdio: 'pipe' as const };
  execSync('git init -b main', gitOpts);
  execSync('git config user.email hydra-telem-e2e@example.com', gitOpts);
  execSync('git config user.name hydra-telem-e2e', gitOpts);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'init\n');
  execSync('git add README.md', gitOpts);
  execSync('git commit -m init', gitOpts);

  function runHydra(args: string[]): { stdout: string; stderr: string; status: number } {
    const r = spawnSync(process.execPath, [cliEntry, '--json', ...args], {
      env: childEnv,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 90_000,
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status ?? -1,
    };
  }

  const copilotSessionName = 'hydra-telem-e2e-copilot';
  const copilotResult = runHydra([
    'copilot', 'create',
    '--agent', STUB_AGENT_NAME,
    '--workdir', repoRoot,
    '--session', copilotSessionName,
  ]);
  if (copilotResult.status !== 0) {
    throw new Error(
      `copilot create failed (status=${copilotResult.status})\n` +
      `stdout: ${copilotResult.stdout}\nstderr: ${copilotResult.stderr}`,
    );
  }
  const copilotInfo = JSON.parse(copilotResult.stdout) as { session: string };

  const workerBranch = 'test-telemetry-e2e';
  const workerResult = runHydra([
    'worker', 'create',
    '--repo', repoRoot,
    '--branch', workerBranch,
    '--agent', STUB_AGENT_NAME,
  ]);
  if (workerResult.status !== 0) {
    throw new Error(
      `worker create failed (status=${workerResult.status})\n` +
      `stdout: ${workerResult.stdout}\nstderr: ${workerResult.stderr}`,
    );
  }
  const workerInfo = JSON.parse(workerResult.stdout) as { session: string; status: string };
  assert.equal(
    workerInfo.status,
    'created',
    `expected worker_created (fresh branch), got status="${workerInfo.status}"`,
  );

  const wDel = runHydra(['worker', 'delete', workerInfo.session]);
  if (wDel.status !== 0) {
    throw new Error(
      `worker delete failed (status=${wDel.status})\n` +
      `stdout: ${wDel.stdout}\nstderr: ${wDel.stderr}`,
    );
  }

  const cDel = runHydra(['copilot', 'delete', copilotInfo.session]);
  if (cDel.status !== 0) {
    throw new Error(
      `copilot delete failed (status=${cDel.status})\n` +
      `stdout: ${cDel.stdout}\nstderr: ${cDel.stderr}`,
    );
  }

  const logPath = path.join(hydraHome, 'telemetry.log');
  assert.ok(
    fs.existsSync(logPath),
    `telemetry.log must exist at ${logPath} after running CLI commands`,
  );

  const raw = fs.readFileSync(logPath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  capturedEvents = lines.map(line => JSON.parse(line) as CapturedEvent);

  console.log(`telemetryE2eSmoke: captured ${capturedEvents.length} events:`);
  for (const e of capturedEvents) {
    const anon = typeof e.properties.anonymous_id === 'string'
      ? e.properties.anonymous_id.slice(0, 8) + '…'
      : '<missing>';
    console.log(
      `  ${e.event.padEnd(18)} ` +
      `agent=${(e.properties.agent ?? '-') as string}  ` +
      `anon=${anon}  ` +
      `version=${e.properties.hydra_version as string}`,
    );
  }

  const expectedOrder = [
    'copilot_created',
    'worker_created',
    'worker_deleted',
    'copilot_deleted',
  ];
  const actualOrder = capturedEvents.map(e => e.event);
  assert.deepEqual(
    actualOrder,
    expectedOrder,
    `event order mismatch.\nexpected: ${JSON.stringify(expectedOrder)}\nactual:   ${JSON.stringify(actualOrder)}`,
  );

  // Auto-attached props on every event.
  for (const e of capturedEvents) {
    const anon = e.properties.anonymous_id;
    assert.ok(
      typeof anon === 'string' && UUID_V4_RE.test(anon),
      `event ${e.event} missing/invalid anonymous_id: ${String(anon)}`,
    );
    assert.equal(typeof e.properties.hydra_version, 'string');
    assert.equal(e.properties.platform, process.platform);
    assert.equal(e.properties.node_version, process.version);
  }

  // All four events should share the same anonymous_id (single process
  // family, single ~/.hydra).
  const ids = new Set(capturedEvents.map(e => e.properties.anonymous_id));
  assert.equal(ids.size, 1, `anonymous_id should be stable across events; got ${[...ids].join(', ')}`);

  // Created events must carry agent="custom" since the stub is non-
  // allowlisted. This doubles as a normalizeAgentForTelemetry assertion
  // through the real CLI flow.
  assert.equal(
    capturedEvents[0].properties.agent,
    'custom',
    'copilot_created.agent must be normalized to "custom" for non-allowlisted stubs',
  );
  assert.equal(
    capturedEvents[1].properties.agent,
    'custom',
    'worker_created.agent must be normalized to "custom" for non-allowlisted stubs',
  );

  console.log('telemetryE2eSmoke: ok');
}

main()
  .catch((err: unknown) => { failure = err; })
  .finally(() => {
    // Kill any tmux sessions on our isolated socket.
    spawnSync('tmux', ['-S', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    rmrf(tempRoot);
    if (failure) {
      console.error(
        'telemetryE2eSmoke: FAIL —',
        failure instanceof Error ? failure.stack ?? failure.message : String(failure),
      );
      process.exitCode = 1;
    }
  });
