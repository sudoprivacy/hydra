/**
 * Smoke test: agent session index rebuild/list/inspect CLI surface.
 *
 * Run: node out/smoke/agentSessionIndexSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { EXIT_CONFLICT, EXIT_NOT_FOUND, EXIT_OK } from '../cli/output';
import { encodeClaudeWorkdir } from '../core/path';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  workdir: string;
  archivedWorkdir: string;
  sudoArchiveFile: string;
  tmuxSocket: string;
  env: Record<string, string | undefined>;
}

interface AgentSessionEntry {
  recordId: string;
  source: 'active' | 'archive';
  role: 'worker' | 'copilot';
  hydraSessionName: string;
  agent: string;
  agentSessionId: string | null;
  storedAgentSessionFile: string | null;
  resolvedAgentSessionFile: string | null;
  agentSessionFileExists: boolean;
  status: 'running' | 'stopped' | 'archived';
  archiveOrdinal: number | null;
  runtimeState?: {
    state: string;
    origin: string;
    reason?: string;
  };
}

interface SessionListJson {
  status: string;
  file: string;
  sessions: AgentSessionEntry[];
  count: number;
}

interface InspectJson {
  status: string;
  session: AgentSessionEntry;
}

interface JsonError {
  error: {
    code: number;
    message: string;
    candidates?: Array<{ recordId: string }>;
  };
}

const ACTIVE_WORKER_SESSION = 'hydra-index-worker';
const ACTIVE_COPILOT_SESSION = 'hydra-index-copilot';
const ARCHIVED_SESSION = 'hydra-index-archived';
const SUDO_ARCHIVED_SESSION = 'hydra-index-sudo-archived';
const ACTIVE_WORKER_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const ACTIVE_COPILOT_SESSION_ID = '22222222-3333-4444-5555-666666666666';
const ARCHIVED_OLD_SESSION_ID = '33333333-4444-5555-6666-777777777777';
const SUDO_SESSION_ID = 'sudo-session-1';

function tmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

function setupContext(): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-agent-session-index-'));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  const workdir = path.join(tmp, 'workdir');
  const archivedWorkdir = path.join(tmp, 'archived-workdir');
  const sudoArchiveDir = path.join(hydraHome, 'agent-sessions', 'sudocode', SUDO_ARCHIVED_SESSION);
  const sudoArchiveFile = path.join(sudoArchiveDir, `${SUDO_SESSION_ID}.jsonl`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(archivedWorkdir, { recursive: true });
  fs.mkdirSync(sudoArchiveDir, { recursive: true });

  writeClaudeTranscript(home, workdir, ACTIVE_WORKER_SESSION_ID);
  writeClaudeTranscript(home, workdir, ACTIVE_COPILOT_SESSION_ID);
  writeClaudeTranscript(home, archivedWorkdir, ACTIVE_WORKER_SESSION_ID);
  writeClaudeTranscript(home, archivedWorkdir, ARCHIVED_OLD_SESSION_ID);
  fs.writeFileSync(
    sudoArchiveFile,
    `${JSON.stringify({ type: 'session_meta', workspace_root: archivedWorkdir })}\n`,
    'utf-8',
  );

  seedSessions(hydraHome, workdir);
  seedArchive(hydraHome, archivedWorkdir, sudoArchiveFile);
  seedRuntimeState(hydraHome, workdir);

  const tmuxSocket = `hydra-agent-session-index-${process.pid}-${Date.now()}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
    HYDRA_TMUX_SOCKET: tmuxSocket,
    HYDRA_TELEMETRY: '0',
  };

  return { tmp, home, hydraHome, configPath, workdir, archivedWorkdir, sudoArchiveFile, tmuxSocket, env };
}

function writeClaudeTranscript(home: string, workdir: string, sessionId: string): void {
  const transcript = path.join(
    home,
    '.claude',
    'projects',
    encodeClaudeWorkdir(workdir),
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '', 'utf-8');
}

function seedSessions(hydraHome: string, workdir: string): void {
  const now = new Date().toISOString();
  const sessions = {
    copilots: {
      [ACTIVE_COPILOT_SESSION]: {
        sessionName: ACTIVE_COPILOT_SESSION,
        displayName: 'index-copilot',
        status: 'running',
        attached: false,
        agent: 'claude',
        copilotMode: 'normal',
        workdir,
        tmuxSession: ACTIVE_COPILOT_SESSION,
        createdAt: now,
        lastSeenAt: now,
        sessionId: ACTIVE_COPILOT_SESSION_ID,
        agentSessionFile: null,
      },
    },
    workers: {
      [ACTIVE_WORKER_SESSION]: {
        source: 'repo',
        sessionName: ACTIVE_WORKER_SESSION,
        displayName: 'index-worker',
        workerId: 7,
        repo: 'fixture',
        repoRoot: workdir,
        branch: 'feature/index',
        slug: 'feature-index',
        status: 'running',
        attached: false,
        agent: 'claude',
        workdir,
        managedWorkdir: false,
        tmuxSession: ACTIVE_WORKER_SESSION,
        createdAt: now,
        lastSeenAt: now,
        sessionId: ACTIVE_WORKER_SESSION_ID,
        agentSessionFile: null,
        copilotSessionName: ACTIVE_COPILOT_SESSION,
      },
    },
    nextWorkerId: 8,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(hydraHome, 'sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`, 'utf-8');
}

function seedArchive(hydraHome: string, archivedWorkdir: string, sudoArchiveFile: string): void {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 60_000).toISOString();
  const entries = [
    archivedWorker(ARCHIVED_SESSION, archivedWorkdir, ARCHIVED_OLD_SESSION_ID, old, 2),
    archivedWorker(ARCHIVED_SESSION, archivedWorkdir, ACTIVE_WORKER_SESSION_ID, now, 3),
    archivedWorker(ACTIVE_WORKER_SESSION, archivedWorkdir, '44444444-5555-6666-7777-888888888888', now, 4),
    archivedSudoWorker(SUDO_ARCHIVED_SESSION, archivedWorkdir, sudoArchiveFile, now),
  ];
  fs.writeFileSync(path.join(hydraHome, 'archive.json'), `${JSON.stringify({ entries }, null, 2)}\n`, 'utf-8');
}

function archivedWorker(
  sessionName: string,
  workdir: string,
  sessionId: string,
  archivedAt: string,
  workerId: number,
): Record<string, unknown> {
  const data = {
    source: 'repo',
    sessionName,
    displayName: sessionName,
    workerId,
    repo: 'fixture',
    repoRoot: workdir,
    branch: `archived-${workerId}`,
    slug: `archived-${workerId}`,
    status: 'stopped',
    attached: false,
    agent: 'claude',
    workdir,
    managedWorkdir: false,
    tmuxSession: sessionName,
    createdAt: archivedAt,
    lastSeenAt: archivedAt,
    sessionId,
    agentSessionFile: null,
    copilotSessionName: null,
  };
  return {
    type: 'worker',
    sessionName,
    agentSessionId: sessionId,
    agentSessionFile: null,
    archivedAt,
    data,
  };
}

function archivedSudoWorker(
  sessionName: string,
  workdir: string,
  sessionFile: string,
  archivedAt: string,
): Record<string, unknown> {
  const data = {
    source: 'directory',
    sessionName,
    displayName: 'sudo-archived',
    workerId: 9,
    repo: null,
    repoRoot: null,
    branch: null,
    slug: 'sudo-archived',
    status: 'stopped',
    attached: false,
    agent: 'sudocode',
    workdir,
    managedWorkdir: true,
    tmuxSession: sessionName,
    createdAt: archivedAt,
    lastSeenAt: archivedAt,
    sessionId: SUDO_SESSION_ID,
    agentSessionFile: sessionFile,
    copilotSessionName: null,
  };
  return {
    type: 'worker',
    sessionName,
    agentSessionId: SUDO_SESSION_ID,
    agentSessionFile: sessionFile,
    archivedAt,
    data,
  };
}

function seedRuntimeState(hydraHome: string, workdir: string): void {
  const runtime = {
    version: 1,
    workers: {
      [ACTIVE_WORKER_SESSION]: {
        sessionName: ACTIVE_WORKER_SESSION,
        state: 'needs-input',
        updatedAt: new Date().toISOString(),
        origin: 'hook',
        reason: 'fixture',
        notificationId: 'notification-1',
        workerId: 7,
        agent: 'claude',
        workdir,
      },
      [ARCHIVED_SESSION]: {
        sessionName: ARCHIVED_SESSION,
        state: 'running',
        updatedAt: new Date().toISOString(),
        origin: 'manual',
        reason: 'stale-archive-state',
        workerId: 3,
        agent: 'claude',
        workdir,
      },
    },
  };
  fs.writeFileSync(path.join(hydraHome, 'worker-runtime-state.json'), `${JSON.stringify(runtime, null, 2)}\n`, 'utf-8');
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
  return execFileSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCliFailure(args: string[], env: Record<string, string | undefined>): { status: number | null; stderr: string } {
  const proc = spawnSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: proc.status, stderr: proc.stderr };
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function runConcurrentRebuilds(ctx: TestContext): Promise<void> {
  const first = spawnRebuild(ctx.env);
  const second = spawnRebuild(ctx.env);
  const results = await Promise.all([waitForProcess(first), waitForProcess(second)]);
  for (const result of results) {
    assert.equal(result.status, EXIT_OK, `concurrent rebuild exit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { status: string; count: number };
    assert.equal(parsed.status, 'rebuilt');
    assert.ok(parsed.count >= 1);
  }
  const indexPath = path.join(ctx.hydraHome, 'agent-sessions.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { sessions: unknown[] };
  assert.ok(Array.isArray(index.sessions), 'agent-sessions.json sessions');
}

function spawnRebuild(env: Record<string, string | undefined>): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, [cliPath, 'session', 'rebuild', '--json'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForProcess(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(cliPath)) {
    console.log(`agentSessionIndexSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }
  if (!tmuxAvailable()) {
    console.log('agentSessionIndexSmoke: skipped (tmux not on PATH)');
    return;
  }

  const ctx = setupContext();
  startTmuxFixtures(ctx.tmuxSocket, [ACTIVE_WORKER_SESSION, ACTIVE_COPILOT_SESSION], ctx.workdir);
  try {
    const rebuild = parseJson<{ status: string; count: number; file: string }>(
      runCli(['session', 'rebuild', '--json'], ctx.env),
    );
    assert.equal(rebuild.status, 'rebuilt');
    assert.equal(rebuild.count, 6, 'rebuild includes active rows and all archive history');
    assert.equal(rebuild.file, path.join(ctx.hydraHome, 'agent-sessions.json'));

    const list = parseJson<SessionListJson>(runCli(['session', 'list', '--json'], ctx.env));
    assert.equal(list.status, 'ok');
    assert.equal(list.count, 4, 'default list uses active-wins plus latest archived per inactive session');
    assert.ok(list.sessions.some(entry => entry.hydraSessionName === ACTIVE_WORKER_SESSION && entry.source === 'active'));
    assert.ok(!list.sessions.some(entry => entry.hydraSessionName === ACTIVE_WORKER_SESSION && entry.source === 'archive'));
    assert.equal(list.sessions.filter(entry => entry.hydraSessionName === ARCHIVED_SESSION).length, 1);
    assert.equal(list.sessions.find(entry => entry.hydraSessionName === ARCHIVED_SESSION)?.agentSessionId, ACTIVE_WORKER_SESSION_ID);

    const worker = list.sessions.find(entry => entry.hydraSessionName === ACTIVE_WORKER_SESSION);
    assert.equal(worker?.runtimeState?.state, 'needs-input');
    assert.equal(worker?.runtimeState?.origin, 'hook');
    const archived = list.sessions.find(entry => entry.hydraSessionName === ARCHIVED_SESSION);
    assert.equal(archived?.runtimeState, undefined, 'archived rows must not reuse stale runtime state');

    const all = parseJson<SessionListJson>(runCli(['session', 'list', '--all', '--json'], ctx.env));
    assert.equal(all.count, 6);
    assert.equal(all.sessions.filter(entry => entry.hydraSessionName === ARCHIVED_SESSION).length, 2);

    const workerOnly = parseJson<SessionListJson>(runCli(['session', 'list', '--role', 'worker', '--source', 'active', '--json'], ctx.env));
    assert.equal(workerOnly.count, 1);
    assert.equal(workerOnly.sessions[0].hydraSessionName, ACTIVE_WORKER_SESSION);

    const inspectCopilotBySession = parseJson<InspectJson>(runCli(['session', 'inspect', ACTIVE_COPILOT_SESSION, '--json'], ctx.env));
    assert.equal(inspectCopilotBySession.session.recordId, `active:copilot:${ACTIVE_COPILOT_SESSION}`);

    const activeNameConflict = runCliFailure(['session', 'inspect', ACTIVE_WORKER_SESSION, '--json'], ctx.env);
    assert.equal(activeNameConflict.status, EXIT_CONFLICT);

    const conflict = runCliFailure(['session', 'inspect', ACTIVE_WORKER_SESSION_ID, '--json'], ctx.env);
    assert.equal(conflict.status, EXIT_CONFLICT);
    const conflictJson = JSON.parse(conflict.stderr) as JsonError;
    assert.equal(conflictJson.error.code, EXIT_CONFLICT);
    assert.ok((conflictJson.error.candidates?.length ?? 0) >= 2);

    const recordId = conflictJson.error.candidates![0].recordId;
    const inspectByRecord = parseJson<InspectJson>(runCli(['session', 'inspect', recordId, '--json'], ctx.env));
    assert.equal(inspectByRecord.session.recordId, recordId);

    const archivedNameConflict = runCliFailure(['session', 'inspect', ARCHIVED_SESSION, '--json'], ctx.env);
    assert.equal(archivedNameConflict.status, EXIT_CONFLICT);

    const sudoList = parseJson<SessionListJson>(runCli(['session', 'list', '--all', '--agent', 'sudocode', '--json'], ctx.env));
    assert.equal(sudoList.count, 1);
    assert.equal(sudoList.sessions[0].storedAgentSessionFile, ctx.sudoArchiveFile);
    assert.equal(sudoList.sessions[0].resolvedAgentSessionFile, ctx.sudoArchiveFile);
    assert.equal(sudoList.sessions[0].agentSessionFileExists, true);
    const relativeSudoFile = path.relative(process.cwd(), ctx.sudoArchiveFile);
    const sudoByRelativeFile = parseJson<InspectJson>(runCli(['session', 'inspect', relativeSudoFile, '--json'], ctx.env));
    assert.equal(sudoByRelativeFile.session.recordId, sudoList.sessions[0].recordId);

    const missing = runCliFailure(['session', 'inspect', 'missing-session', '--json'], ctx.env);
    assert.equal(missing.status, EXIT_NOT_FOUND);

    await runConcurrentRebuilds(ctx);

    console.log('agentSessionIndexSmoke: ok');
  } finally {
    killTmuxServer(ctx.tmuxSocket);
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
