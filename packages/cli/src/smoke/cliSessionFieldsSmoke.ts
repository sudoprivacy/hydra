/**
 * Smoke test: end-to-end CLI verification that `hydra list --json` exposes
 * sessionId, sessionFile, and agentSessionId for both copilots and workers.
 *
 * The smoke creates an isolated HYDRA_HOME with a seeded sessions.json, points
 * HOME at a fixture transcript layout, and runs the compiled CLI in a
 * subprocess. tmux is steered onto a unique socket so live-session reconcile
 * sees an empty server (the seeded worker therefore persists as `stopped`).
 *
 * Skipped cleanly when tmux is not on PATH.
 *
 * Run:  node out/smoke/cliSessionFieldsSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeClaudeWorkdir } from '@hydra/core/path';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface ListJsonEntry {
  sessionId: string | null;
  sessionFile: string | null;
  agentSessionId: string | null;
  mode?: string;
  [k: string]: unknown;
}
interface ListJson {
  copilots: ListJsonEntry[];
  workers: ListJsonEntry[];
  count: number;
}

function tmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

function setupFixture(): {
  tmp: string;
  home: string;
  hydraHome: string;
  workdir: string;
  workerSession: string;
  copilotSession: string;
  workerSessionId: string;
  copilotSessionId: string;
  workerTranscript: string;
  copilotTranscript: string;
  tmuxSocket: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cli-fields-'));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const workdir = path.join(tmp, 'workdir');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  const workerSession = 'hydra-cli-fields-worker';
  const copilotSession = 'hydra-cli-fields-copilot';
  const workerSessionId = '11111111-2222-3333-4444-555555555555';
  const copilotSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // Seed transcript files so resolveAgentSessionFile returns a non-null path.
  const workerTranscript = path.join(
    home, '.claude', 'projects', encodeClaudeWorkdir(workdir), `${workerSessionId}.jsonl`,
  );
  const copilotTranscript = path.join(
    home, '.claude', 'projects', encodeClaudeWorkdir(workdir), `${copilotSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(workerTranscript), { recursive: true });
  fs.writeFileSync(workerTranscript, '');
  fs.writeFileSync(copilotTranscript, '');

  const now = new Date().toISOString();
  const sessions = {
    copilots: {
      [copilotSession]: {
        sessionName: copilotSession,
        displayName: copilotSession,
        status: 'running', // overridden by sync; non-live + no live → deleted, so include below as live via tmux
        attached: false,
        agent: 'claude',
        workdir,
        tmuxSession: copilotSession,
        createdAt: now,
        lastSeenAt: now,
        sessionId: copilotSessionId,
      },
    },
    workers: {
      [workerSession]: {
        sessionName: workerSession,
        displayName: 'cli-fields',
        workerId: 1,
        repo: 'fixture',
        repoRoot: workdir,
        branch: 'main',
        slug: 'cli-fields',
        status: 'running',
        attached: false,
        agent: 'claude',
        workdir,
        tmuxSession: workerSession,
        createdAt: now,
        lastSeenAt: now,
        sessionId: workerSessionId,
        copilotSessionName: null,
      },
    },
    nextWorkerId: 2,
    updatedAt: now,
  };
  fs.writeFileSync(
    path.join(hydraHome, 'sessions.json'),
    JSON.stringify(sessions, null, 2),
  );

  // Unique tmux socket name so we never collide with a real tmux server.
  const tmuxSocket = `hydra-cli-fields-${process.pid}-${Date.now()}`;

  return {
    tmp, home, hydraHome, workdir,
    workerSession, copilotSession,
    workerSessionId, copilotSessionId,
    workerTranscript, copilotTranscript,
    tmuxSocket,
  };
}

function startTmuxFixtures(socket: string, sessions: string[], cwd: string): void {
  for (const name of sessions) {
    spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, '-c', cwd], {
      stdio: 'ignore',
    });
  }
}

function killTmuxServer(socket: string): void {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
}

function runCli(args: string[], env: Record<string, string | undefined>): string {
  return execFileSync('node', [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertSessionFields(entry: ListJsonEntry | undefined, sessionId: string, transcript: string, label: string): void {
  assert.ok(entry, `expected ${label} entry in list output`);
  assert.equal(entry!.sessionId, sessionId, `${label}.sessionId`);
  assert.equal(entry!.agentSessionId, sessionId, `${label}.agentSessionId`);
  assert.equal(entry!.sessionFile, transcript, `${label}.sessionFile`);
}

function main(): void {
  if (!tmuxAvailable()) {
    console.log('cliSessionFieldsSmoke: skipped (tmux not on PATH)');
    return;
  }
  if (!fs.existsSync(cliPath)) {
    console.log(`cliSessionFieldsSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const ctx = setupFixture();
  // Start a tmux server on the isolated socket with two sessions so the
  // seeded copilot/worker reconcile to `running` and stay in the JSON output.
  startTmuxFixtures(ctx.tmuxSocket, [ctx.copilotSession, ctx.workerSession], ctx.workdir);

  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: ctx.home,
      USERPROFILE: ctx.home,
      HYDRA_HOME: ctx.hydraHome,
      HYDRA_TMUX_SOCKET: ctx.tmuxSocket,
      // Force telemetry off so the smoke does not emit network/IO noise.
      HYDRA_TELEMETRY: '0',
    };

    const listOut = runCli(['list', '--json'], env);
    const list = JSON.parse(listOut) as ListJson;
    assert.ok(Array.isArray(list.workers), 'list.workers must be an array');
    assert.ok(Array.isArray(list.copilots), 'list.copilots must be an array');

    const worker = list.workers.find(w => w.session === ctx.workerSession);
    const copilot = list.copilots.find(c => c.session === ctx.copilotSession);
    assertSessionFields(worker, ctx.workerSessionId, ctx.workerTranscript, 'worker');
    assertSessionFields(copilot, ctx.copilotSessionId, ctx.copilotTranscript, 'copilot');
    assert.equal(copilot!.mode, 'normal', 'copilot.mode');

    // worker logs --json: confirm sessionId/sessionFile present.
    const workerLogsOut = runCli(['worker', 'logs', ctx.workerSession, '--lines', '1', '--json'], env);
    const workerLogs = JSON.parse(workerLogsOut) as { sessionId: string | null; sessionFile: string | null };
    assert.equal(workerLogs.sessionId, ctx.workerSessionId, 'worker logs sessionId');
    assert.equal(workerLogs.sessionFile, ctx.workerTranscript, 'worker logs sessionFile');

    // copilot logs --json: confirm sessionId/sessionFile present.
    const copilotLogsOut = runCli(['copilot', 'logs', ctx.copilotSession, '--lines', '1', '--json'], env);
    const copilotLogs = JSON.parse(copilotLogsOut) as { sessionId: string | null; sessionFile: string | null };
    assert.equal(copilotLogs.sessionId, ctx.copilotSessionId, 'copilot logs sessionId');
    assert.equal(copilotLogs.sessionFile, ctx.copilotTranscript, 'copilot logs sessionFile');

    console.log('cliSessionFieldsSmoke: ok');
  } finally {
    killTmuxServer(ctx.tmuxSocket);
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

main();
