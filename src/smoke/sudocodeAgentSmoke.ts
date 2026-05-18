/**
 * Smoke test for Sudo Code agent support.
 *
 * Run: node out/smoke/sudocodeAgentSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentSupportsCompletionNotification,
  buildAgentLaunchCommand,
  buildAgentResumeCommand,
  buildAgentResumePlan,
  extractAgentCommandExecutable,
} from '../core/agentConfig';
import { SessionManager } from '../core/sessionManager';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';

class FakeBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake';
  readonly installHint = 'fake';
  readonly sentKeys: string[] = [];
  readonly messages: string[] = [];
  private pendingPaneOutput: string | null = null;
  private pendingCaptureCount = 0;

  constructor(private paneOutput: string) {}

  setPaneOutput(output: string): void {
    this.paneOutput = output;
  }

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> { return []; }
  async createSession(): Promise<void> {}
  async killSession(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false; }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<HydraRole | undefined> { return undefined; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return undefined; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(_sessionName: string, keys: string): Promise<void> {
    this.sentKeys.push(keys);
    if (keys === 'y') {
      this.setPaneOutput('❯');
    }
  }
  async capturePane(): Promise<string> {
    if (this.pendingPaneOutput) {
      if (this.pendingCaptureCount <= 0) {
        this.paneOutput = this.pendingPaneOutput;
        this.pendingPaneOutput = null;
      } else {
        this.pendingCaptureCount -= 1;
      }
    }
    return this.paneOutput;
  }
  async sendMessage(_sessionName: string, message: string): Promise<void> {
    this.messages.push(message);
    if (message.startsWith('/resume ')) {
      this.setPaneOutput(`${this.paneOutput}\n${message}`);
      this.pendingPaneOutput = `${this.paneOutput}\nSession resumed\n  Messages         2\n❯`;
      this.pendingCaptureCount = 1;
    }
  }
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

interface UnsafeSessionManager {
  captureAgentSessionInfo(
    sessionName: string,
    agentType: string,
    workdir: string,
    launchStartedAt?: number,
  ): Promise<{ sessionId: string | null; agentSessionFile: string | null }>;
  findLatestSudoCodeSessionInfo(
    workdir: string,
    minMtimeMs?: number,
  ): { sessionId: string | null; agentSessionFile: string | null };
  launchAgentResume(
    sessionName: string,
    agentType: string,
    agentCommand: string,
    sessionId: string,
    workdir: string,
    agentSessionFile?: string | null,
  ): Promise<void>;
  getDefaultAgentCommand(agentType: string): string;
  waitForAgentReady(sessionName: string, agentType: string): Promise<void>;
}

function testAgentConfig(): void {
  assert.equal(
    buildAgentLaunchCommand('sudocode', 'scode', 'Implement the task'),
    'scode --dangerously-skip-permissions',
  );
  assert.equal(
    buildAgentLaunchCommand('sudocode', 'scode --dangerously-skip-permissions', 'Implement the task'),
    'scode --dangerously-skip-permissions',
  );
  assert.equal(buildAgentResumeCommand('sudocode', 'scode', 'session-1-0'), null);

  const plan = buildAgentResumePlan(
    'sudocode',
    'scode',
    'session-1-0',
    '/workspace',
    '/tmp/session-1-0.jsonl',
  );
  assert.deepEqual(plan, {
    strategy: 'replSlashCommand',
    command: 'scode --dangerously-skip-permissions',
    slashCommand: '/resume /tmp/session-1-0.jsonl',
  });

  const spacedPathPlan = buildAgentResumePlan(
    'sudocode',
    'scode',
    'session-1-0',
    '/workspace',
    '/tmp/hydra sessions/session-1-0.jsonl',
  );
  assert.equal(
    spacedPathPlan?.strategy === 'replSlashCommand' ? spacedPathPlan.slashCommand : null,
    '/resume /tmp/hydra sessions/session-1-0.jsonl',
    'Sudo Code /resume consumes the full remainder, so paths with spaces stay raw',
  );

  assert.equal(extractAgentCommandExecutable('env HTTPS_PROXY=http://127.0.0.1:7897 scode'), 'scode');
  assert.equal(
    extractAgentCommandExecutable('/usr/bin/env HTTPS_PROXY=http://127.0.0.1:7897 scode'),
    'scode',
  );
  assert.equal(extractAgentCommandExecutable('env -u FOO BAR=1 /opt/bin/scode'), '/opt/bin/scode');
  assert.equal(extractAgentCommandExecutable('scode --dangerously-skip-permissions'), 'scode');

  assert.equal(agentSupportsCompletionNotification('claude'), true);
  assert.equal(agentSupportsCompletionNotification('codex'), true);
  assert.equal(agentSupportsCompletionNotification('gemini'), true);
  assert.equal(agentSupportsCompletionNotification('sudocode'), false);
}

async function testSudoCodeSessionCapture(): Promise<void> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-capture-'));
  try {
    const output = [
      'Sudo Code',
      '│   Session          session-1778831515919-0                                        │',
      '│   Auto-save        .scode/sessions/ea44ee3d072f6b6a/session-1778831515919-0.jsonl │',
      '',
      '❯',
    ].join('\n');
    const backend = new FakeBackend(output);
    const sm = new SessionManager(backend) as unknown as UnsafeSessionManager;
    const captured = await sm.captureAgentSessionInfo('s', 'sudocode', workdir);

    assert.equal(captured.sessionId, 'session-1778831515919-0');
    assert.equal(
      captured.agentSessionFile,
      path.join(workdir, '.scode', 'sessions', 'ea44ee3d072f6b6a', 'session-1778831515919-0.jsonl'),
    );
    assert.deepEqual(backend.messages, [], 'startup banner should avoid an extra /status round trip');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function testSudoCodeSessionFileFallback(): void {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-file-fallback-'));
  try {
    const sessionId = 'session-1778836161133-0';
    const sessionFile = path.join(workdir, '.scode', 'sessions', 'd42d407d9f3027ab', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session_meta', session_id: sessionId })}\n`,
      'utf-8',
    );

    const backend = new FakeBackend('❯');
    const sm = new SessionManager(backend) as unknown as UnsafeSessionManager;
    assert.deepEqual(sm.findLatestSudoCodeSessionInfo(workdir), {
      sessionId,
      agentSessionFile: sessionFile,
    });
    assert.deepEqual(sm.findLatestSudoCodeSessionInfo(workdir, Date.now() + 60_000), {
      sessionId: null,
      agentSessionFile: null,
    });
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function testHydraGlobalAgentCommandFallback(): void {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-global-config-'));
  const oldConfigPath = process.env.HYDRA_CONFIG_PATH;
  const oldHome = process.env.HYDRA_HOME;
  try {
    process.env.HYDRA_HOME = path.join(configRoot, 'home');
    process.env.HYDRA_CONFIG_PATH = path.join(configRoot, 'config.json');
    fs.writeFileSync(
      process.env.HYDRA_CONFIG_PATH,
      JSON.stringify({
        cli: { extensionPath: '/extension', version: 'test' },
        agentCommands: { sudocode: 'env HTTPS_PROXY=http://127.0.0.1:7897 scode' },
      }),
      'utf-8',
    );

    const sm = new SessionManager(new FakeBackend('')) as unknown as UnsafeSessionManager;
    assert.equal(sm.getDefaultAgentCommand('sudocode'), 'env HTTPS_PROXY=http://127.0.0.1:7897 scode');
    assert.equal(sm.getDefaultAgentCommand('unknown-agent'), 'unknown-agent');
  } finally {
    if (oldConfigPath === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = oldConfigPath;
    }
    if (oldHome === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = oldHome;
    }
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
}

async function testSudoCodeResumeLaunch(): Promise<void> {
  const backend = new FakeBackend('❯');
  const sm = new SessionManager(backend) as unknown as UnsafeSessionManager;

  await sm.launchAgentResume(
    's',
    'sudocode',
    'scode',
    'session-1778831515919-0',
    '/workspace',
    '/tmp/session-1778831515919-0.jsonl',
  );

  assert.deepEqual(backend.sentKeys, ['scode --dangerously-skip-permissions']);
  assert.deepEqual(backend.messages, ['/resume /tmp/session-1778831515919-0.jsonl']);
  assert.match(await backend.capturePane(), /Session resumed[\s\S]*❯/);
}

async function testSudoCodeStartSkipsMismatchedWorkspaceSessionFile(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-start-resolve-'));
  const oldHome = process.env.HYDRA_HOME;
  const oldConfigPath = process.env.HYDRA_CONFIG_PATH;

  try {
    const hydraHome = path.join(root, 'home');
    const workdir = path.join(root, 'worktree-renamed');
    const oldWorkdir = path.join(root, 'worktree-old');
    const sessionName = 'repo_worker';
    const sessionId = 'session-1778843662908-0';
    const newSessionId = 'session-1778844056844-0';
    const oldSessionFile = path.join(oldWorkdir, '.scode', 'sessions', 'hash', `${sessionId}.jsonl`);
    const movedSessionFile = path.join(workdir, '.scode', 'sessions', 'hash', `${sessionId}.jsonl`);
    const newSessionFile = path.join(workdir, '.scode', 'sessions', 'newhash', `${newSessionId}.jsonl`);

    process.env.HYDRA_HOME = hydraHome;
    process.env.HYDRA_CONFIG_PATH = path.join(root, 'config.json');
    fs.mkdirSync(path.dirname(movedSessionFile), { recursive: true });
    fs.writeFileSync(
      movedSessionFile,
      `${JSON.stringify({ type: 'session_meta', session_id: sessionId, workspace_root: oldWorkdir })}\n`,
      'utf-8',
    );
    fs.mkdirSync(hydraHome, { recursive: true });

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(hydraHome, 'sessions.json'),
      JSON.stringify({
        copilots: {},
        workers: {
          [sessionName]: {
            sessionName,
            displayName: 'worker',
            workerId: 1,
            repo: 'repo',
            repoRoot: workdir,
            branch: 'branch',
            slug: 'worker',
            status: 'stopped',
            attached: false,
            agent: 'sudocode',
            workdir,
            tmuxSession: sessionName,
            createdAt: now,
            lastSeenAt: now,
            sessionId,
            agentSessionFile: oldSessionFile,
            copilotSessionName: null,
          },
        },
        nextWorkerId: 2,
        updatedAt: now,
      }, null, 2),
      'utf-8',
    );

    const backend = new FakeBackend([
      'Sudo Code',
      `│   Session          ${newSessionId}                                        │`,
      `│   Auto-save        .scode/sessions/newhash/${newSessionId}.jsonl │`,
      '',
      '❯',
    ].join('\n'));
    const sm = new SessionManager(backend);
    const result = await sm.startWorker(sessionName);
    await result.postCreatePromise;

    assert.deepEqual(backend.messages, []);
    assert.equal(backend.sentKeys.length, 1);
    assert.match(backend.sentKeys[0], /scode'?\s+--dangerously-skip-permissions$/);

    const updated = JSON.parse(fs.readFileSync(path.join(hydraHome, 'sessions.json'), 'utf-8'));
    assert.equal(updated.workers[sessionName].sessionId, newSessionId);
    assert.equal(updated.workers[sessionName].agentSessionFile, newSessionFile);
  } finally {
    if (oldHome === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = oldHome;
    }
    if (oldConfigPath === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = oldConfigPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testSudoCodeBroadDirectoryPrompt(): Promise<void> {
  const backend = new FakeBackend('Continue anyway? [y/N]:');
  const sm = new SessionManager(backend) as unknown as UnsafeSessionManager;

  await sm.waitForAgentReady('s', 'sudocode');

  assert.deepEqual(backend.sentKeys, ['y']);
}

async function main(): Promise<void> {
  testAgentConfig();
  await testSudoCodeSessionCapture();
  testSudoCodeSessionFileFallback();
  testHydraGlobalAgentCommandFallback();
  await testSudoCodeResumeLaunch();
  await testSudoCodeStartSkipsMismatchedWorkspaceSessionFile();
  await testSudoCodeBroadDirectoryPrompt();
  console.log('sudocodeAgentSmoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
