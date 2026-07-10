import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';

const APPROVAL_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const HOOK_TRUST_BYPASS_FLAG = '--dangerously-bypass-hook-trust';
const BYPASS_FLAGS = `${APPROVAL_BYPASS_FLAG} ${HOOK_TRUST_BYPASS_FLAG}`;

type SessionRecord = {
  agent?: string;
  role?: HydraRole;
  workdir?: string;
};

class FakeBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake-tmux';
  readonly installHint = 'not needed';

  readonly sendKeysCalls: Array<{ sessionName: string; keys: string }> = [];
  readonly sendMessageCalls: Array<{ sessionName: string; message: string }> = [];
  readonly capturePaneCalls: Array<{ sessionName: string; lines?: number }> = [];
  readonly paneOutputs = new Map<string, string>();

  private readonly sessions = new Map<string, SessionRecord>();

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return [...this.sessions.entries()].map(([name, session]) => ({
      name,
      windows: 1,
      attached: false,
      workdir: session.workdir,
    }));
  }

  async createSession(sessionName: string, cwd: string): Promise<void> {
    this.sessions.set(sessionName, { workdir: cwd });
  }

  async killSession(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const session = this.sessions.get(oldName);
    if (session) {
      this.sessions.set(newName, session);
      this.sessions.delete(oldName);
    }
  }

  async hasSession(sessionName: string): Promise<boolean> {
    return this.sessions.has(sessionName);
  }

  async getSessionWorkdir(sessionName: string): Promise<string | undefined> {
    return this.sessions.get(sessionName)?.workdir;
  }

  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> {
    const session = this.sessions.get(sessionName) || {};
    session.workdir = workdir;
    this.sessions.set(sessionName, session);
  }

  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> {
    return this.sessions.get(sessionName)?.role;
  }

  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> {
    const session = this.sessions.get(sessionName) || {};
    session.role = role;
    this.sessions.set(sessionName, session);
  }

  async getSessionAgent(sessionName: string): Promise<string | undefined> {
    return this.sessions.get(sessionName)?.agent;
  }

  async setSessionAgent(sessionName: string, agent: string): Promise<void> {
    const session = this.sessions.get(sessionName) || {};
    session.agent = agent;
    this.sessions.set(sessionName, session);
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    this.sendKeysCalls.push({ sessionName, keys });
  }

  async capturePane(sessionName: string, lines?: number): Promise<string> {
    this.capturePaneCalls.push({ sessionName, lines });
    return this.paneOutputs.get(sessionName) || '⏵';
  }

  async sendMessage(sessionName: string, message: string): Promise<void> {
    this.sendMessageCalls.push({ sessionName, message });
  }

  async getSessionInfo(): Promise<SessionStatusInfo> {
    return { attached: false, lastActive: 0 };
  }

  async getSessionPaneCount(): Promise<number> {
    return 1;
  }

  async getSessionPanePids(): Promise<string[]> {
    return [];
  }

  async splitPane(): Promise<void> {}

  async newWindow(): Promise<void> {}

  buildSessionName(repoName: string, slug: string): string {
    return `${this.sanitizeSessionName(repoName)}_${this.sanitizeSessionName(slug)}`;
  }

  sanitizeSessionName(name: string): string {
    return name.replace(/[/\\\s.:]/g, '-');
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readEvents(hydraDir: string): Array<{ type: string; session?: string; payload?: Record<string, unknown> }> {
  const eventsPath = path.join(hydraDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; session?: string; payload?: Record<string, unknown> });
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function patchModule(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): () => void {
  const originals = new Map<string, unknown>();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, target[key]);
    target[key] = value;
  }

  return () => {
    for (const [key, value] of originals.entries()) {
      target[key] = value;
    }
  };
}

function lastSendKeysFor(backend: FakeBackend, sessionName: string): string {
  const call = [...backend.sendKeysCalls].reverse().find(entry => entry.sessionName === sessionName);
  assert.ok(call, `Expected a sendKeys call for ${sessionName}`);
  return call.keys;
}

function shellQuoteForExpected(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '`"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function withCopilotSessionEnv(sessionName: string, command: string): string {
  if (process.platform === 'win32') {
    return `$env:${HYDRA_COPILOT_SESSION_ENV}=${shellQuoteForExpected(sessionName)}; ${command}`;
  }
  return `${HYDRA_COPILOT_SESSION_ENV}=${shellQuoteForExpected(sessionName)} ${command}`;
}

function forceFastSleeps(sessionManager: object): void {
  (sessionManager as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-codex-bypass-'));
  process.env.HOME = tempHome;

  const hydraDir = path.join(tempHome, '.hydra');
  process.env.HYDRA_HOME = hydraDir;
  const sessionsFile = path.join(hydraDir, 'sessions.json');
  const archiveFile = path.join(hydraDir, 'archive.json');

  const agentConfig = await import('../core/agentConfig');
  const coreGit = await import('../core/git') as unknown as Record<string, unknown>;
  const { SessionManager } = await import('../core/sessionManager');
  const { WorkerLifecycleService } = await import('../core/workerLifecycleService');

  const launchCommand = agentConfig.buildAgentLaunchCommand('codex', 'codex');
  assert.equal(launchCommand, `codex ${BYPASS_FLAGS}`);

  const dedupedLaunchCommand = agentConfig.buildAgentLaunchCommand(
    'codex',
    `codex ${BYPASS_FLAGS}`,
  );
  assert.equal(countOccurrences(dedupedLaunchCommand, APPROVAL_BYPASS_FLAG), 1);
  assert.equal(countOccurrences(dedupedLaunchCommand, HOOK_TRUST_BYPASS_FLAG), 1);

  const resumeCommand = agentConfig.buildAgentResumeCommand('codex', 'codex', 'resume-session-id');
  assert.equal(
    resumeCommand,
    `codex ${BYPASS_FLAGS} resume 'resume-session-id'`,
  );

  const dedupedResumeCommand = agentConfig.buildAgentResumeCommand(
    'codex',
    `codex ${BYPASS_FLAGS}`,
    'resume-session-id',
  );
  assert.ok(dedupedResumeCommand);
  assert.equal(countOccurrences(dedupedResumeCommand, APPROVAL_BYPASS_FLAG), 1);
  assert.equal(countOccurrences(dedupedResumeCommand, HOOK_TRUST_BYPASS_FLAG), 1);

  assert.equal(
    agentConfig.buildAgentLaunchCommand('codex', 'codex', undefined, undefined, { copilotMode: 'plan' }),
    'codex --sandbox read-only --ask-for-approval never',
  );
  assert.equal(
    agentConfig.buildAgentResumeCommand('codex', 'codex', 'resume-session-id', '/workspace', { copilotMode: 'plan' }),
    "codex --sandbox read-only --ask-for-approval never resume -C '/workspace' 'resume-session-id'",
  );
  assert.throws(
    () => agentConfig.buildAgentLaunchCommand('codex', `codex ${APPROVAL_BYPASS_FLAG}`, undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode cannot use unsafe agent flag/,
  );

  const smokeCodexCommand = 'codex-smoke-test';
  agentConfig.DEFAULT_AGENT_COMMANDS.codex = smokeCodexCommand;

  {
    const backend = new FakeBackend();
    backend.paneOutputs.set(
      'copilot-fresh',
      'Session: 11111111-1111-4111-8111-111111111111\n⏵',
    );
    const sm = new SessionManager(backend);
    forceFastSleeps(sm);

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-copilot-fresh-'));
    const copilot = await sm.createCopilotAndFinalize({
      workdir,
      agentType: 'codex',
      sessionName: 'copilot-fresh',
    });

    assert.equal(
      backend.sendKeysCalls[0]?.keys,
      withCopilotSessionEnv('copilot-fresh', `${smokeCodexCommand} ${BYPASS_FLAGS}`),
    );
    assert.equal(
      backend.sendMessageCalls.some(call => call.sessionName === 'copilot-fresh' && call.message === '/status'),
      false,
    );
    assert.equal(copilot.sessionId, '11111111-1111-4111-8111-111111111111');
  }

  {
    const copilotRestoredWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-copilot-restored-'));
    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    archive.entries.push({
      type: 'copilot',
      sessionName: 'copilot-restored',
      agentSessionId: '22222222-2222-4222-8222-222222222222',
      archivedAt: new Date().toISOString(),
      data: {
        sessionName: 'copilot-restored',
        displayName: 'copilot-restored',
        status: 'stopped',
        attached: false,
        agent: 'codex',
        copilotMode: 'normal',
        workdir: copilotRestoredWorkdir,
        tmuxSession: 'copilot-restored',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    });
    writeJson(archiveFile, archive);

    const backend = new FakeBackend();
    backend.paneOutputs.set('copilot-restored', '⏵');
    const sm = new SessionManager(backend);
    forceFastSleeps(sm);

    const copilot = await sm.restoreCopilotAndFinalize('copilot-restored');
    const command = lastSendKeysFor(backend, 'copilot-restored');

    assert.equal(
      command,
      withCopilotSessionEnv(
        'copilot-restored',
        `${smokeCodexCommand} ${BYPASS_FLAGS} resume -C '${copilotRestoredWorkdir}' '22222222-2222-4222-8222-222222222222'`,
      ),
    );
    assert.ok(
      backend.capturePaneCalls.some(call => call.sessionName === 'copilot-restored'),
    );
    assert.equal(copilot.sessionId, '22222222-2222-4222-8222-222222222222');
  }

  {
    const copilotPlanRestoredWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-copilot-plan-restored-'));
    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    archive.entries.push({
      type: 'copilot',
      sessionName: 'copilot-plan-restored',
      agentSessionId: '33333333-3333-4333-8333-333333333333',
      archivedAt: new Date().toISOString(),
      data: {
        sessionName: 'copilot-plan-restored',
        displayName: 'copilot-plan-restored',
        status: 'stopped',
        attached: false,
        agent: 'codex',
        copilotMode: 'plan',
        workdir: copilotPlanRestoredWorkdir,
        tmuxSession: 'copilot-plan-restored',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: '33333333-3333-4333-8333-333333333333',
      },
    });
    writeJson(archiveFile, archive);

    const backend = new FakeBackend();
    backend.paneOutputs.set('copilot-plan-restored', '⏵');
    const sm = new SessionManager(backend);
    forceFastSleeps(sm);

    const copilot = await sm.restoreCopilotAndFinalize('copilot-plan-restored');
    const command = lastSendKeysFor(backend, 'copilot-plan-restored');

    assert.equal(
      command,
      withCopilotSessionEnv(
        'copilot-plan-restored',
        `${smokeCodexCommand} --sandbox read-only --ask-for-approval never resume -C '${copilotPlanRestoredWorkdir}' '33333333-3333-4333-8333-333333333333'`,
      ),
    );
    assert.equal(copilot.copilotMode, 'plan');
    assert.equal(copilot.sessionId, '33333333-3333-4333-8333-333333333333');
  }

  {
    const copilotStartWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-copilot-start-'));
    const state = readJson<Record<string, unknown>>(sessionsFile, {
      copilots: {},
      workers: {},
      nextWorkerId: 1,
      updatedAt: new Date().toISOString(),
    });
    const copilots = (state.copilots as Record<string, unknown>) || {};
    copilots['copilot-start'] = {
      sessionName: 'copilot-start',
      displayName: 'copilot-start',
      status: 'stopped',
      attached: false,
      agent: 'codex',
      copilotMode: 'normal',
      workdir: copilotStartWorkdir,
      tmuxSession: 'copilot-start',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      sessionId: '55555555-5555-4555-8555-555555555555',
      agentSessionFile: null,
    };
    state.copilots = copilots;
    writeJson(sessionsFile, state);

    const backend = new FakeBackend();
    backend.paneOutputs.set('copilot-start', '⏵');
    const sm = new SessionManager(backend);
    forceFastSleeps(sm);

    const result = await sm.startCopilot('copilot-start');
    await result.postCreatePromise;

    const command = lastSendKeysFor(backend, 'copilot-start');
    assert.equal(
      command,
      withCopilotSessionEnv(
        'copilot-start',
        `${smokeCodexCommand} ${BYPASS_FLAGS} resume -C '${copilotStartWorkdir}' '55555555-5555-4555-8555-555555555555'`,
      ),
    );
    assert.equal(result.resumed, true);
    const startedEvent = readEvents(hydraDir)
      .find(event => event.type === 'copilot.started' && event.session === 'copilot-start');
    assert.ok(startedEvent, 'startCopilot should emit copilot.started');
    assert.equal(startedEvent?.payload?.resumed, true);
  }

  {
    const workerWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-start-'));
    const state = readJson<Record<string, unknown>>(sessionsFile, {
      copilots: {},
      workers: {},
      nextWorkerId: 2,
      updatedAt: new Date().toISOString(),
    });
    const workers = (state.workers as Record<string, unknown>) || {};
    workers['worker-start'] = {
      sessionName: 'worker-start',
      displayName: 'worker-start',
      workerId: 1,
      repo: 'repo',
      repoRoot: workerWorkdir,
      branch: 'fix/codex-start',
      slug: 'fix-codex-start',
      status: 'stopped',
      attached: false,
      agent: 'codex',
      workdir: workerWorkdir,
      tmuxSession: 'worker-start',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      sessionId: '33333333-3333-4333-8333-333333333333',
      copilotSessionName: null,
    };
    state.workers = workers;
    writeJson(sessionsFile, state);

    const backend = new FakeBackend();
    backend.paneOutputs.set('worker-start', '⏵');
    const sm = new SessionManager(backend);
    forceFastSleeps(sm);

    const result = await sm.startWorker('worker-start');
    await result.postCreatePromise;

    const command = lastSendKeysFor(backend, 'worker-start');
    assert.equal(
      command,
      `${smokeCodexCommand} ${BYPASS_FLAGS} resume -C '${workerWorkdir}' '33333333-3333-4333-8333-333333333333'`,
    );
    assert.ok(
      backend.capturePaneCalls.some(call => call.sessionName === 'worker-start'),
      'startWorker should wait for the resumed agent to become ready',
    );
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-restore-repo-'));
    const restoredWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-restore-worktree-'));
    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    archive.entries.push({
      type: 'worker',
      sessionName: 'worker-restored',
      agentSessionId: '44444444-4444-4444-8444-444444444444',
      archivedAt: new Date().toISOString(),
      data: {
        sessionName: 'worker-restored',
        displayName: 'worker-restored',
        workerId: 2,
        repo: 'repo',
        repoRoot,
        branch: 'fix/codex-restored',
        slug: 'fix-codex-restored',
        status: 'stopped',
        attached: false,
        agent: 'codex',
        workdir: restoredWorktree,
        tmuxSession: 'worker-restored',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: '44444444-4444-4444-8444-444444444444',
        copilotSessionName: null,
      },
    });
    writeJson(archiveFile, archive);

    const restoreCoreGit = patchModule(coreGit, {
      validateBranchName: () => undefined,
      getRepoSessionNamespace: () => 'repo-ns',
      localBranchExists: async () => false,
      fetchOrigin: async () => {},
      getBaseBranchFromRepo: async () => 'main',
      getLocalAheadCount: async () => 0,
      branchNameToSlug: () => 'fix-codex-restored',
      isSlugTaken: async () => false,
      addWorktree: async () => restoredWorktree,
      getRepoName: () => 'repo',
    });

    try {
      const backend = new FakeBackend();
      backend.paneOutputs.set('worker-restored', '⏵');
      const sm = new SessionManager(backend);
      forceFastSleeps(sm);

      const result = await sm.restoreWorker('worker-restored');
      await result.postCreatePromise;

      const command = lastSendKeysFor(backend, 'worker-restored');
      assert.ok(command.startsWith(`${smokeCodexCommand} -c `), 'restored worker should enable structured hooks');
      assert.ok(command.includes('features.hooks=true'));
      assert.ok(command.includes('completion-worker-2.sh'));
      assert.ok(command.includes(BYPASS_FLAGS));
      assert.ok(command.endsWith(
        `resume -C '${restoredWorktree}' '44444444-4444-4444-8444-444444444444'`,
      ));
      assert.equal(result.workerInfo.sessionName, 'worker-restored');
      assert.equal(result.workerInfo.sessionId, '44444444-4444-4444-8444-444444444444');
      assert.ok(
        backend.capturePaneCalls.some(call => call.sessionName === 'worker-restored'),
      );
    } finally {
      restoreCoreGit();
    }
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-slug-collision-repo-'));
    const fooBarWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-foo-bar-'));
    const fooSlashBarWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-foo-slash-bar-'));
    const now = new Date().toISOString();
    writeJson(sessionsFile, {
      copilots: {},
      workers: {
        'repo-ns_foo-bar': {
          sessionName: 'repo-ns_foo-bar',
          displayName: 'foo-bar',
          workerId: 10,
          repo: 'repo',
          repoRoot,
          branch: 'foo-bar',
          slug: 'foo-bar',
          status: 'running',
          attached: false,
          agent: 'codex',
          workdir: fooBarWorktree,
          tmuxSession: 'repo-ns_foo-bar',
          createdAt: now,
          lastSeenAt: now,
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          copilotSessionName: null,
        },
        'repo-ns_foo-bar-2': {
          sessionName: 'repo-ns_foo-bar-2',
          displayName: 'foo-bar-2',
          workerId: 11,
          repo: 'repo',
          repoRoot,
          branch: 'foo/bar',
          slug: 'foo-bar-2',
          status: 'stopped',
          attached: false,
          agent: 'codex',
          workdir: fooSlashBarWorktree,
          tmuxSession: 'repo-ns_foo-bar-2',
          createdAt: now,
          lastSeenAt: now,
          sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          copilotSessionName: null,
        },
      },
      nextWorkerId: 12,
      updatedAt: now,
    });

    const restoreCoreGit = patchModule(coreGit, {
      validateBranchName: () => undefined,
      getRepoSessionNamespace: () => 'repo-ns',
      localBranchExists: async (_repoRoot: string, branchName: string) => branchName === 'foo/bar',
      branchNameToSlug: () => 'foo-bar',
      getRepoName: () => 'repo',
      getWorktreeBranch: async (_repoRoot: string, worktreePath: string) => {
        if (worktreePath === fooBarWorktree) return 'foo-bar';
        if (worktreePath === fooSlashBarWorktree) return 'foo/bar';
        return undefined;
      },
    });

    try {
      const backend = new FakeBackend();
      await backend.createSession('repo-ns_foo-bar', fooBarWorktree);
      await backend.setSessionAgent('repo-ns_foo-bar', 'codex');
      backend.paneOutputs.set('repo-ns_foo-bar-2', '⏵');
      const sm = new SessionManager(backend);
      forceFastSleeps(sm);
      const lifecycle = new WorkerLifecycleService({ backend, sessionManager: sm, eventSource: 'cli' });

      const result = await lifecycle.createWorker({
        repoRoot,
        branchName: 'foo/bar',
        agentType: 'codex',
        task: 'resume foo slash bar',
      });
      await result.postCreatePromise;

      assert.equal(result.workerInfo.sessionName, 'repo-ns_foo-bar-2');
      assert.equal(result.workerInfo.slug, 'foo-bar-2');
      assert.equal(result.workerInfo.workdir, fooSlashBarWorktree);
      assert.equal(
        lastSendKeysFor(backend, 'repo-ns_foo-bar-2'),
        `${smokeCodexCommand} ${BYPASS_FLAGS} resume -C '${fooSlashBarWorktree}' 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`,
      );
      assert.ok(
        backend.sendMessageCalls.some(call =>
          call.sessionName === 'repo-ns_foo-bar-2' && call.message === 'resume foo slash bar'
        ),
      );
      const startedEvent = readEvents(hydraDir)
        .find(event => event.type === 'worker.started' && event.session === 'repo-ns_foo-bar-2');
      assert.ok(startedEvent, 'Existing-branch resume should emit worker.started');
      assert.equal(startedEvent?.payload?.resumed, true);
      assert.equal(startedEvent?.payload?.alreadyRunning, false);
      assert.equal(
        backend.sendKeysCalls.some(call =>
          call.sessionName === 'repo-ns_foo-bar' && call.keys === 'resume foo slash bar'
        ),
        false,
      );
    } finally {
      restoreCoreGit();
    }
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-live-resume-repo-'));
    const liveWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-live-resume-worktree-'));
    const now = new Date().toISOString();
    writeJson(sessionsFile, {
      copilots: {},
      workers: {
        'repo-ns_live-branch': {
          sessionName: 'repo-ns_live-branch',
          displayName: 'live-branch',
          workerId: 21,
          repo: 'repo',
          repoRoot,
          branch: 'live/branch',
          slug: 'live-branch',
          status: 'running',
          attached: false,
          agent: 'codex',
          workdir: liveWorktree,
          tmuxSession: 'repo-ns_live-branch',
          createdAt: now,
          lastSeenAt: now,
          sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          copilotSessionName: null,
        },
      },
      nextWorkerId: 22,
      updatedAt: now,
    });

    const restoreCoreGit = patchModule(coreGit, {
      validateBranchName: () => undefined,
      getRepoSessionNamespace: () => 'repo-ns',
      localBranchExists: async (_repoRoot: string, branchName: string) => branchName === 'live/branch',
      branchNameToSlug: () => 'live-branch',
      getRepoName: () => 'repo',
    });

    try {
      const backend = new FakeBackend();
      await backend.createSession('repo-ns_live-branch', liveWorktree);
      await backend.setSessionRole('repo-ns_live-branch', 'worker');
      await backend.setSessionAgent('repo-ns_live-branch', 'codex');
      const sm = new SessionManager(backend);
      forceFastSleeps(sm);
      const lifecycle = new WorkerLifecycleService({ backend, sessionManager: sm, eventSource: 'cli' });

      const result = await lifecycle.createWorker({
        repoRoot,
        branchName: 'live/branch',
        agentType: 'codex',
        task: 'reuse live branch',
      });
      await result.postCreatePromise;

      assert.equal(result.workerInfo.sessionName, 'repo-ns_live-branch');
      assert.ok(
        backend.sendMessageCalls.some(call =>
          call.sessionName === 'repo-ns_live-branch' && call.message === 'reuse live branch'
        ),
      );
      const startedEvent = readEvents(hydraDir)
        .find(event => event.type === 'worker.started' && event.session === 'repo-ns_live-branch');
      assert.ok(startedEvent, 'Live existing branch should emit worker.started');
      assert.equal(startedEvent?.payload?.resumed, true);
      assert.equal(startedEvent?.payload?.alreadyRunning, true);
    } finally {
      restoreCoreGit();
    }
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-stale-archive-repo-'));
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-stale-archive-managed-'));
    const currentWorktree = path.join(managedDir, 'foo-bar');
    fs.mkdirSync(currentWorktree, { recursive: true });
    const staleWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-stale-archive-old-'));
    const now = new Date().toISOString();
    writeJson(sessionsFile, {
      copilots: {},
      workers: {},
      nextWorkerId: 20,
      updatedAt: now,
    });
    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    archive.entries.push({
      type: 'worker',
      sessionName: 'repo-ns_foo-bar-2',
      agentSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      archivedAt: now,
      data: {
        sessionName: 'repo-ns_foo-bar-2',
        displayName: 'foo-bar-2',
        workerId: 19,
        repo: 'repo',
        repoRoot,
        branch: 'foo/bar',
        slug: 'foo-bar-2',
        status: 'stopped',
        attached: false,
        agent: 'codex',
        workdir: staleWorktree,
        tmuxSession: 'repo-ns_foo-bar-2',
        createdAt: now,
        lastSeenAt: now,
        sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        copilotSessionName: null,
      },
    });
    writeJson(archiveFile, archive);

    const restoreCoreGit = patchModule(coreGit, {
      validateBranchName: () => undefined,
      getRepoSessionNamespace: () => 'repo-ns',
      localBranchExists: async (_repoRoot: string, branchName: string) => branchName === 'foo/bar',
      branchNameToSlug: () => 'foo-bar',
      getRepoName: () => 'repo',
      getManagedRepoWorktreesDir: () => managedDir,
      getInRepoWorktreesDir: () => path.join(managedDir, 'legacy-in-repo'),
      getLegacyTmuxWorktreesDir: () => path.join(managedDir, 'legacy-tmux'),
      getWorktreeBranch: async (_repoRoot: string, worktreePath: string) => {
        if (worktreePath === currentWorktree) return 'foo/bar';
        if (worktreePath === staleWorktree) return 'foo/bar';
        return undefined;
      },
    });

    try {
      const backend = new FakeBackend();
      backend.paneOutputs.set(
        'repo-ns_foo-bar',
        'Session: cccccccc-cccc-4ccc-8ccc-cccccccccccc\n⏵',
      );
      const sm = new SessionManager(backend);
      forceFastSleeps(sm);
      const lifecycle = new WorkerLifecycleService({ backend, sessionManager: sm, eventSource: 'cli' });

      const result = await lifecycle.createWorker({
        repoRoot,
        branchName: 'foo/bar',
        agentType: 'codex',
        task: 'start current branch',
      });
      await result.postCreatePromise;

      assert.equal(result.workerInfo.sessionName, 'repo-ns_foo-bar');
      assert.equal(result.workerInfo.slug, 'foo-bar');
      assert.equal(result.workerInfo.workdir, currentWorktree);
      assert.ok(
        backend.sendKeysCalls.some(call =>
          call.sessionName === 'repo-ns_foo-bar' && call.keys === `${smokeCodexCommand} ${BYPASS_FLAGS}`
        ),
      );
      assert.equal(
        backend.sendKeysCalls.some(call => call.sessionName === 'repo-ns_foo-bar-2'),
        false,
      );
      const startedEvent = readEvents(hydraDir)
        .find(event => event.type === 'worker.started' && event.session === 'repo-ns_foo-bar');
      assert.ok(startedEvent, 'Existing branch fresh start should emit worker.started');
      assert.equal(startedEvent?.payload?.resumed, false);
      assert.equal(startedEvent?.payload?.alreadyRunning, false);
    } finally {
      restoreCoreGit();
    }
  }

  console.log('codexBypassSmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
