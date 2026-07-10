import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';

type ExecFailure = Error & {
  stderr?: string;
  stdout?: string;
  code?: number | string;
};

type WorkerRecord = {
  sessionName: string;
  displayName: string;
  workerId: number;
  repo: string;
  repoRoot: string;
  branch: string;
  slug: string;
  status: 'running' | 'stopped';
  attached: boolean;
  agent: string;
  workdir: string;
  tmuxSession: string;
  createdAt: string;
  lastSeenAt: string;
  sessionId: string | null;
  copilotSessionName: string | null;
};

class DeleteWorkerBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake-tmux';
  readonly installHint = 'not needed';

  private readonly sessions = new Set<string>();
  private readonly workers = new Map<string, WorkerRecord>();

  killError: Error | null = null;
  hasSessionError: Error | null = null;

  constructor(workers: WorkerRecord[] = []) {
    for (const worker of workers) {
      this.sessions.add(worker.sessionName);
      this.workers.set(worker.sessionName, worker);
    }
  }

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return [];
  }

  async createSession(): Promise<void> {
    this.unexpected();
  }

  async killSession(sessionName: string): Promise<void> {
    if (this.killError) {
      throw this.killError;
    }
    this.sessions.delete(sessionName);
  }

  async renameSession(): Promise<void> {
    this.unexpected();
  }

  async hasSession(sessionName: string): Promise<boolean> {
    if (this.hasSessionError) {
      throw this.hasSessionError;
    }
    return this.sessions.has(sessionName);
  }

  async getSessionWorkdir(sessionName: string): Promise<string | undefined> {
    return this.workers.get(sessionName)?.workdir;
  }

  async setSessionWorkdir(): Promise<void> {
    this.unexpected();
  }

  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> {
    return this.workers.has(sessionName) ? 'worker' : undefined;
  }

  async setSessionRole(): Promise<void> {
    this.unexpected();
  }

  async getSessionWorkerId(sessionName: string): Promise<number | undefined> {
    return this.workers.get(sessionName)?.workerId;
  }

  async getSessionAgent(): Promise<string | undefined> {
    this.unexpected();
  }

  async setSessionAgent(): Promise<void> {
    this.unexpected();
  }

  async sendKeys(): Promise<void> {
    this.unexpected();
  }

  async capturePane(): Promise<string> {
    this.unexpected();
  }

  async sendMessage(): Promise<void> {
    this.unexpected();
  }

  async getSessionInfo(): Promise<SessionStatusInfo> {
    this.unexpected();
  }

  async getSessionPaneCount(): Promise<number> {
    this.unexpected();
  }

  async getSessionPanePids(): Promise<string[]> {
    this.unexpected();
  }

  async splitPane(): Promise<void> {
    this.unexpected();
  }

  async newWindow(): Promise<void> {
    this.unexpected();
  }

  buildSessionName(repoName: string, slug: string): string {
    return `${repoName}_${slug}`;
  }

  sanitizeSessionName(name: string): string {
    return name;
  }

  private unexpected(): never {
    throw new Error('Unexpected backend call in worker delete smoke test');
  }
}

function makeExecError(message: string, stderr?: string, stdout?: string, code?: number | string): ExecFailure {
  const error = new Error(message) as ExecFailure;
  error.stderr = stderr;
  error.stdout = stdout;
  if (code !== undefined) {
    error.code = code;
  }
  return error;
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

function buildWorker(sessionName: string, repoRoot: string, workdir: string): WorkerRecord {
  const now = new Date().toISOString();
  return {
    sessionName,
    displayName: sessionName,
    workerId: 1,
    repo: 'repo',
    repoRoot,
    branch: 'fix/delete-worker',
    slug: 'fix-delete-worker',
    status: 'running',
    attached: false,
    agent: 'codex',
    workdir,
    tmuxSession: sessionName,
    createdAt: now,
    lastSeenAt: now,
    sessionId: '55555555-5555-4555-8555-555555555555',
    copilotSessionName: null,
  };
}

function writeWorkerState(sessionsFile: string, worker: WorkerRecord): void {
  writeJson(sessionsFile, {
    copilots: {},
    workers: {
      [worker.sessionName]: worker,
    },
    nextWorkerId: worker.workerId + 1,
    updatedAt: new Date().toISOString(),
  });
}

function writeWorkerRuntimeState(runtimeStateFile: string, worker: WorkerRecord): void {
  writeJson(runtimeStateFile, {
    version: 1,
    workers: {
      [worker.sessionName]: {
        sessionName: worker.sessionName,
        state: 'running',
        updatedAt: new Date().toISOString(),
        origin: 'session-manager',
        reason: 'worker-created',
        workerId: worker.workerId,
        agent: worker.agent,
        workdir: worker.workdir,
      },
    },
  });
}

function readWorkerRuntimeState(runtimeStateFile: string, sessionName: string): unknown {
  const state = readJson<{ workers?: Record<string, unknown> }>(runtimeStateFile, { workers: {} });
  return state.workers?.[sessionName];
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-'));
  process.env.HOME = tempHome;

  const hydraDir = path.join(tempHome, '.hydra');
  process.env.HYDRA_HOME = hydraDir;
  delete process.env.HYDRA_CONFIG_PATH;

  const sessionsFile = path.join(hydraDir, 'sessions.json');
  const archiveFile = path.join(hydraDir, 'archive.json');
  const runtimeStateFile = path.join(hydraDir, 'worker-runtime-state.json');

  const coreExec = await import('../core/exec') as unknown as Record<string, unknown>;
  const coreGit = await import('../core/git') as unknown as Record<string, unknown>;
  const { SessionManager } = await import('../core/sessionManager');
  const { TmuxBackendCore, TmuxUnavailableError } = await import('../core/tmux');

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-repo-'));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-worktree-'));
    const worker = buildWorker('worker-delete-fail-closed', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeJson(archiveFile, { entries: [] });

    const backend = new DeleteWorkerBackend([worker]);
    backend.killError = makeExecError('kill-session failed', 'permission denied');

    let removeWorktreeCalls = 0;
    const branchDeleteCommands: string[] = [];
    const restoreCoreGit = patchModule(coreGit, {
      isGitRepo: async () => true,
      removeWorktree: async () => {
        removeWorktreeCalls += 1;
      },
    });
    const restoreExec = patchModule(coreExec, {
      exec: async (command: string) => {
        branchDeleteCommands.push(command);
        return '';
      },
    });

    try {
      const sm = new SessionManager(backend);
      await assert.rejects(
        sm.deleteWorker(worker.sessionName),
        /kill-session failed/,
      );
    } finally {
      restoreExec();
      restoreCoreGit();
    }

    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    const state = readJson<{ workers: Record<string, unknown> }>(sessionsFile, { workers: {} });
    assert.equal(archive.entries.length, 0);
    assert.ok(state.workers[worker.sessionName], 'sessions.json entry should remain after kill failure');
    assert.equal(removeWorktreeCalls, 0);
    assert.equal(branchDeleteCommands.length, 0);
    assert.ok(fs.existsSync(workdir), 'worktree should remain after kill failure');
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-repo-'));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-worktree-'));
    const worker = buildWorker('worker-delete-already-gone', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeJson(archiveFile, { entries: [] });

    const backend = new DeleteWorkerBackend();
    backend.killError = makeExecError('kill-session failed', `can't find session: ${worker.sessionName}`);

    let removeWorktreeCalls = 0;
    const branchDeleteCommands: string[] = [];
    const restoreCoreGit = patchModule(coreGit, {
      isGitRepo: async () => true,
      removeWorktree: async () => {
        removeWorktreeCalls += 1;
      },
    });
    const restoreExec = patchModule(coreExec, {
      exec: async (command: string) => {
        branchDeleteCommands.push(command);
        return '';
      },
    });

    try {
      const sm = new SessionManager(backend);
      await sm.deleteWorker(worker.sessionName);
    } finally {
      restoreExec();
      restoreCoreGit();
    }

    const archive = readJson<{ entries: Array<{ sessionName: string }> }>(archiveFile, { entries: [] });
    const state = readJson<{ workers: Record<string, unknown> }>(sessionsFile, { workers: {} });
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0]?.sessionName, worker.sessionName);
    assert.equal(state.workers[worker.sessionName], undefined);
    assert.equal(removeWorktreeCalls, 1);
    assert.equal(branchDeleteCommands.length, 1);
    assert.match(branchDeleteCommands[0] || '', /git branch -D/);
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-repo-'));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-worktree-'));
    const worker = buildWorker('worker-delete-worktree-fails', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeWorkerRuntimeState(runtimeStateFile, worker);
    writeJson(archiveFile, { entries: [] });

    const backend = new DeleteWorkerBackend([worker]);

    let removeWorktreeCalls = 0;
    const branchDeleteCommands: string[] = [];
    const restoreCoreGit = patchModule(coreGit, {
      isGitRepo: async () => true,
      removeWorktree: async () => {
        removeWorktreeCalls += 1;
        throw makeExecError('worktree remove failed', 'contains modified or untracked files');
      },
    });
    const restoreExec = patchModule(coreExec, {
      exec: async (command: string) => {
        branchDeleteCommands.push(command);
        return '';
      },
    });

    try {
      const sm = new SessionManager(backend);
      await assert.rejects(
        sm.deleteWorker(worker.sessionName),
        /worktree remove failed/,
      );
    } finally {
      restoreExec();
      restoreCoreGit();
    }

    const archive = readJson<{ entries: Array<Record<string, unknown>> }>(archiveFile, { entries: [] });
    const state = readJson<{ workers: Record<string, { status?: string; attached?: boolean }> }>(
      sessionsFile,
      { workers: {} },
    );
    assert.equal(archive.entries.length, 0);
    assert.ok(state.workers[worker.sessionName], 'sessions.json entry should remain after worktree removal failure');
    assert.equal(state.workers[worker.sessionName]?.status, 'stopped');
    assert.equal(state.workers[worker.sessionName]?.attached, false);
    assert.equal(removeWorktreeCalls, 1);
    assert.equal(branchDeleteCommands.length, 0);
    assert.equal(await backend.hasSession(worker.sessionName), false);
    assert.ok(fs.existsSync(workdir), 'worktree should remain after worktree removal failure');
    assert.ok(readWorkerRuntimeState(runtimeStateFile, worker.sessionName), 'runtime state should remain after worktree removal failure');
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-repo-'));
    const workdir = path.join(os.tmpdir(), `hydra-worker-delete-missing-${Date.now()}`);
    const worker = buildWorker('worker-delete-workdir-missing', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeWorkerRuntimeState(runtimeStateFile, worker);
    writeJson(archiveFile, { entries: [] });

    const backend = new DeleteWorkerBackend();
    backend.killError = makeExecError('kill-session failed', `can't find session: ${worker.sessionName}`);

    let isGitRepoCalls = 0;
    let removeWorktreeCalls = 0;
    const branchDeleteCommands: string[] = [];
    const restoreCoreGit = patchModule(coreGit, {
      isGitRepo: async () => {
        isGitRepoCalls += 1;
        return true;
      },
      removeWorktree: async () => {
        removeWorktreeCalls += 1;
      },
    });
    const restoreExec = patchModule(coreExec, {
      exec: async (command: string) => {
        branchDeleteCommands.push(command);
        return '';
      },
    });

    try {
      const sm = new SessionManager(backend);
      await sm.deleteWorker(worker.sessionName);
    } finally {
      restoreExec();
      restoreCoreGit();
    }

    const archive = readJson<{ entries: Array<{ sessionName: string }> }>(archiveFile, { entries: [] });
    const state = readJson<{ workers: Record<string, unknown> }>(sessionsFile, { workers: {} });
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0]?.sessionName, worker.sessionName);
    assert.equal(state.workers[worker.sessionName], undefined);
    assert.equal(isGitRepoCalls, 0);
    assert.equal(removeWorktreeCalls, 0);
    assert.equal(branchDeleteCommands.length, 0);
    assert.equal(readWorkerRuntimeState(runtimeStateFile, worker.sessionName), undefined);
  }

  {
    const repoRoot = path.join(os.tmpdir(), `hydra-worker-delete-missing-repo-${Date.now()}`);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-worktree-'));
    const worker = buildWorker('worker-delete-repo-root-missing', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeWorkerRuntimeState(runtimeStateFile, worker);
    writeJson(archiveFile, { entries: [] });

    const backend = new DeleteWorkerBackend();
    backend.killError = makeExecError('kill-session failed', `can't find session: ${worker.sessionName}`);

    let isGitRepoCalls = 0;
    let removeWorktreeCalls = 0;
    const branchDeleteCommands: string[] = [];
    const restoreCoreGit = patchModule(coreGit, {
      isGitRepo: async () => {
        isGitRepoCalls += 1;
        return true;
      },
      removeWorktree: async () => {
        removeWorktreeCalls += 1;
      },
    });
    const restoreExec = patchModule(coreExec, {
      exec: async (command: string) => {
        branchDeleteCommands.push(command);
        return '';
      },
    });

    try {
      const sm = new SessionManager(backend);
      await sm.deleteWorker(worker.sessionName);
    } finally {
      restoreExec();
      restoreCoreGit();
    }

    const archive = readJson<{ entries: Array<{ sessionName: string }> }>(archiveFile, { entries: [] });
    const state = readJson<{ workers: Record<string, unknown> }>(sessionsFile, { workers: {} });
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0]?.sessionName, worker.sessionName);
    assert.equal(state.workers[worker.sessionName], undefined);
    assert.equal(isGitRepoCalls, 0);
    assert.equal(removeWorktreeCalls, 0);
    assert.equal(branchDeleteCommands.length, 0);
    assert.ok(fs.existsSync(workdir), 'workdir should not be deleted when repo root is missing');
    assert.equal(readWorkerRuntimeState(runtimeStateFile, worker.sessionName), undefined);
  }

  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-delete-repo-'));
    const workdir = path.join(os.tmpdir(), `hydra-worker-delete-sync-orphan-${Date.now()}`);
    const worker = buildWorker('worker-sync-orphan-runtime-clear', repoRoot, workdir);
    writeWorkerState(sessionsFile, worker);
    writeWorkerRuntimeState(runtimeStateFile, worker);

    const backend = new DeleteWorkerBackend();
    const sm = new SessionManager(backend);
    const synced = await sm.sync();

    const state = readJson<{ workers: Record<string, unknown> }>(sessionsFile, { workers: {} });
    assert.equal(synced.workers[worker.sessionName], undefined);
    assert.equal(state.workers[worker.sessionName], undefined);
    assert.equal(readWorkerRuntimeState(runtimeStateFile, worker.sessionName), undefined);
  }

  {
    const restoreExec = patchModule(coreExec, {
      exec: async () => {
        throw makeExecError('missing session', `can't find session: worker-missing`);
      },
    });

    try {
      const backend = new TmuxBackendCore();
      assert.equal(await backend.hasSession('worker-missing'), false);
    } finally {
      restoreExec();
    }
  }

  {
    const restoreExec = patchModule(coreExec, {
      exec: async () => {
        throw makeExecError('tmux unavailable', 'permission denied');
      },
    });

    try {
      const backend = new TmuxBackendCore();
      await assert.rejects(
        backend.hasSession('worker-error'),
        (error: unknown) => {
          assert.ok(error instanceof TmuxUnavailableError);
          assert.match((error as Error).message, /Unable to inspect tmux session "worker-error"/);
          return true;
        },
      );
    } finally {
      restoreExec();
    }
  }

  // Regression for issue #195: psmux on Windows exits non-zero with empty
  // stderr when has-session finds no match. The keyword detectors don't
  // recognize that, so the silent-exit branch must treat it as "missing".
  {
    const restoreExec = patchModule(coreExec, {
      exec: async () => {
        throw makeExecError(
          'Command failed: psmux has-session -t "hydra-copilot-codex"',
          '',
          '',
          1,
        );
      },
    });

    try {
      const backend = new TmuxBackendCore();
      assert.equal(await backend.hasSession('hydra-copilot-codex'), false);
    } finally {
      restoreExec();
    }
  }

  console.log('workerDeleteFailClosedSmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
