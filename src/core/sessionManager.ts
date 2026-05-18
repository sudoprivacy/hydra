import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MultiplexerBackendCore } from './types';
import * as coreGit from './git';
import { ensureHydraGlobalConfig, getHydraGlobalAgentCommand } from './hydraGlobalConfig';
import { buildAgentLaunchCommand, buildAgentResumePlan, DEFAULT_AGENT_COMMANDS, AGENT_SESSION_CAPTURE, CLAUDE_READY_DELAY_MS, AGENT_READY_PATTERNS, AGENT_READY_TIMEOUT_MS, AGENT_READY_POLL_INTERVAL_MS, CLAUDE_TRUST_PROMPT_PATTERN, CODEX_RESUME_CWD_PROMPT_PATTERN, SUDOCODE_BROAD_DIRECTORY_PROMPT_PATTERN, agentSupportsCompletionNotification } from './agentConfig';
import { exec, resolveCommandPath } from './exec';
import { getHydraArchiveFile, getHydraHome, getHydraSessionsFile, resolveAgentSessionFile, toCanonicalPath } from './path';
import { shellQuote } from './shell';

const POST_CREATE_TIMEOUT_MS = AGENT_READY_TIMEOUT_MS + 75000;
const SESSION_STATE_LOCK_TIMEOUT_MS = 10000;
const SESSION_STATE_LOCK_RETRY_MS = 50;
const SESSION_STATE_LOCK_STALE_MS = 120000;

/** Known symlink paths that git may convert to plain text files on Windows. */
const KNOWN_SYMLINK_PATHS = [
  '.claude/skills',
  '.codex/skills',
  '.gemini/skills',
  '.sudocode/skills',
];

/**
 * On Windows, git converts symlinks to plain text files containing the target path.
 * This function detects those broken symlinks and replaces them with NTFS junctions
 * (which don't require admin privileges).
 */
function fixWindowsSymlinks(worktreeDir: string): void {
  if (process.platform !== 'win32') {
    return;
  }

  for (const relPath of KNOWN_SYMLINK_PATHS) {
    const fullPath = path.join(worktreeDir, relPath);
    try {
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile()) {
        continue;
      }
      // Git writes the symlink target as the file content
      const target = fs.readFileSync(fullPath, 'utf-8').trim();
      if (!target) {
        continue;
      }
      const resolvedTarget = path.resolve(path.dirname(fullPath), target);
      if (!fs.existsSync(resolvedTarget)) {
        continue;
      }
      fs.unlinkSync(fullPath);
      fs.symlinkSync(resolvedTarget, fullPath, 'junction');
    } catch {
      // Best-effort — skip if anything goes wrong
    }
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const next = text.indexOf(needle, index);
    if (next < 0) {
      return count;
    }
    count += 1;
    index = next + needle.length;
  }
}

function rebasePathUnderDirectory(filePath: string | null | undefined, oldDir: string, newDir: string): string | null {
  if (!filePath || !oldDir || !newDir) {
    return null;
  }

  const normalizedFile = path.normalize(path.resolve(filePath));
  const normalizedOldDir = path.normalize(path.resolve(oldDir));
  if (normalizedFile !== normalizedOldDir && !normalizedFile.startsWith(`${normalizedOldDir}${path.sep}`)) {
    return null;
  }

  return path.join(newDir, path.relative(normalizedOldDir, normalizedFile));
}

/**
 * Look up a worker's numeric ID from sessions.json.
 * Lightweight standalone function — no SessionManager instance needed.
 */
export function lookupWorkerId(sessionName: string): number | undefined {
  try {
    const sessionsFile = getHydraSessionsFile();
    if (fs.existsSync(sessionsFile)) {
      const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
      return parsed.workers?.[sessionName]?.workerId;
    }
  } catch {
    // Best-effort
  }
  return undefined;
}

// ── Types ──

export interface WorkerInfo {
  sessionName: string;
  /** Human-friendly name for display (the branch slug without the hash prefix). */
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
  /** Absolute path to the agent's native session/transcript file, when captured. */
  agentSessionFile?: string | null;
  /** Session name of the copilot that spawned this worker, if any. */
  copilotSessionName: string | null;
}

export interface CopilotInfo {
  sessionName: string;
  /** Human-friendly name for display (the user-given copilot name). */
  displayName: string;
  status: 'running' | 'stopped';
  attached: boolean;
  agent: string;
  workdir: string;
  tmuxSession: string;
  createdAt: string;
  lastSeenAt: string;
  sessionId: string | null;
  /** Absolute path to the agent's native session/transcript file, when captured. */
  agentSessionFile?: string | null;
}

export interface SessionState {
  copilots: Record<string, CopilotInfo>;
  workers: Record<string, WorkerInfo>;
  nextWorkerId: number;
  updatedAt: string;
}

export interface ArchivedSessionInfo {
  type: 'worker' | 'copilot';
  sessionName: string;
  agentSessionId: string | null;
  agentSessionFile?: string | null;
  archivedAt: string;
  data: WorkerInfo | CopilotInfo;
}

export interface ArchiveState {
  entries: ArchivedSessionInfo[];
}

interface SavedWorkerMatch {
  worker: WorkerInfo;
  stateKey?: string;
}

export interface CreateWorkerOpts {
  repoRoot: string;
  branchName: string;
  agentType?: string;
  baseBranchOverride?: string;
  task?: string;
  taskFile?: string;
  agentCommand?: string;
  /** When set, launch the agent with --resume instead of a fresh session. */
  resumeSessionId?: string;
  /** Native session file to use for agents whose resume command accepts paths. */
  resumeSessionFile?: string | null;
  /** Session name of the copilot that spawned this worker. */
  copilotSessionName?: string;
  /** Whether to notify the parent copilot when the worker completes (default: true). */
  notifyCopilot?: boolean;
  /** Existing persisted identity to preserve when restoring an archived worker. */
  preservedWorkerInfo?: WorkerInfo;
  /**
   * Pre-create fetch behaviour:
   *   'best-effort' — default, swallow errors (used for ad-hoc abs-path repos)
   *   'required'    — error out if fetch fails (used for ~/.hydra/repos/-managed repos)
   */
  fetchMode?: 'best-effort' | 'required';
}

export interface CreateCopilotOpts {
  workdir: string;
  agentType?: string;
  /** User-given name for the copilot (used as displayName). */
  name?: string;
  sessionName?: string;
  agentCommand?: string;
  /** When set, launch the agent with --resume instead of a fresh session. */
  resumeSessionId?: string;
  /** Native session file to use for agents whose resume command accepts paths. */
  resumeSessionFile?: string | null;
}

export interface CreateWorkerResult {
  workerInfo: WorkerInfo;
  /** Resolves after the delayed Enter is sent (for Claude trust prompt). CLI should await this. */
  postCreatePromise: Promise<void>;
}

export interface CreateCopilotResult {
  copilotInfo: CopilotInfo;
  /** Resolves after the agent is ready and any deferred session ID capture has completed. */
  postCreatePromise: Promise<void>;
}

// ── SessionManager Class ──

export class SessionManager {
  constructor(private backend: MultiplexerBackendCore) {}

  // ── Sync: reconcile sessions.json <-> live multiplexer ──

  async sync(): Promise<SessionState> {
    const liveSessions = await this.backend.listSessions();
    const liveSessionMap = new Map(liveSessions.map(s => [s.name, s]));
    const discoveredSessions = new Map<string, {
      role: 'worker' | 'copilot';
      agent: string;
      workdir: string;
    }>();

    await Promise.all(liveSessions.map(async (session) => {
      const role = await this.backend.getSessionRole(session.name);
      if (role !== 'worker' && role !== 'copilot') return;

      const [agent, workdir] = await Promise.all([
        this.backend.getSessionAgent(session.name),
        this.backend.getSessionWorkdir(session.name),
      ]);

      discoveredSessions.set(session.name, {
        role,
        agent: agent || 'unknown',
        workdir: workdir || '',
      });
    }));

    return this.updateSessionState((state) => {
      const now = new Date().toISOString();

      // Reconcile workers
      for (const [key, worker] of Object.entries(state.workers)) {
        // Backfill workerId for workers created before this feature
        if (worker.workerId == null) {
          worker.workerId = state.nextWorkerId++;
        }
        const live = liveSessionMap.get(worker.sessionName);
        if (live) {
          worker.status = 'running';
          worker.attached = live.attached;
          worker.lastSeenAt = now;
        } else if (worker.workdir && fs.existsSync(worker.workdir)) {
          worker.status = 'stopped';
          worker.attached = false;
        } else {
          // Orphan: tmux dead + no worktree
          delete state.workers[key];
        }
      }

      // Reconcile copilots
      for (const [key, copilot] of Object.entries(state.copilots)) {
        const live = liveSessionMap.get(copilot.sessionName);
        if (live) {
          copilot.status = 'running';
          copilot.attached = live.attached;
          copilot.lastSeenAt = now;
        } else {
          delete state.copilots[key];
        }
      }

      // Discover live sessions with @hydra-role not yet in JSON
      const knownSessionNames = new Set([
        ...Object.values(state.workers).map(w => w.sessionName),
        ...Object.values(state.copilots).map(c => c.sessionName),
      ]);

      for (const session of liveSessions) {
        if (knownSessionNames.has(session.name)) continue;

        const discovered = discoveredSessions.get(session.name);
        if (!discovered) continue;

        if (discovered.role === 'worker') {
          // Derive repoRoot from workdir path via .repo-root marker or legacy path pattern
          let repoRoot = '';
          if (discovered.workdir) {
            repoRoot = coreGit.resolveRepoRootFromWorktreePath(discovered.workdir) || '';
          }
          const slug = this.extractSlugFromSessionName(session.name);
          state.workers[session.name] = {
            sessionName: session.name,
            displayName: slug,
            workerId: state.nextWorkerId++,
            repo: repoRoot ? path.basename(repoRoot) : 'unknown',
            repoRoot,
            branch: '',
            slug,
            status: 'running',
            attached: session.attached,
            agent: discovered.agent,
            workdir: discovered.workdir,
            tmuxSession: session.name,
            createdAt: now,
            lastSeenAt: now,
            sessionId: null,
            agentSessionFile: null,
            copilotSessionName: null,
          };
        } else {
          state.copilots[session.name] = {
            sessionName: session.name,
            displayName: session.name,
            status: 'running',
            attached: session.attached,
            agent: discovered.agent,
            workdir: discovered.workdir,
            tmuxSession: session.name,
            createdAt: now,
            lastSeenAt: now,
            sessionId: null,
            agentSessionFile: null,
          };
        }
      }

      state.updatedAt = now;
      return state;
    });
  }

  async listWorkers(repoRoot?: string): Promise<WorkerInfo[]> {
    const state = await this.sync();
    const workers = Object.values(state.workers);
    if (!repoRoot) return workers;
    const canonical = path.resolve(repoRoot);
    return workers.filter(w => path.resolve(w.repoRoot) === canonical);
  }

  async listCopilots(repoRoot?: string): Promise<CopilotInfo[]> {
    const state = await this.sync();
    const copilots = Object.values(state.copilots);
    if (!repoRoot) return copilots;
    const canonical = path.resolve(repoRoot);
    return copilots.filter(c => c.workdir && path.resolve(c.workdir).startsWith(canonical));
  }

  async getWorker(sessionName: string): Promise<WorkerInfo | undefined> {
    const state = await this.sync();
    return state.workers[sessionName];
  }

  armCompletionNotification(sessionName: string): void {
    const hooksDir = path.join(getHydraHome(), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.closeSync(fs.openSync(this.getNotifyPendingPath(sessionName), 'w'));
  }

  async getCopilot(sessionName: string): Promise<CopilotInfo | undefined> {
    const state = await this.sync();
    return state.copilots[sessionName];
  }

  // ── Worker Lifecycle ──

  async createWorker(opts: CreateWorkerOpts): Promise<CreateWorkerResult> {
    ensureHydraGlobalConfig();

    const { repoRoot, branchName } = opts;
    let { task, taskFile } = opts;
    const agentType = opts.agentType || 'claude';
    let agentCommand = await this.resolveAgentCommand(opts.agentCommand || this.getDefaultAgentCommand(agentType));

    const validationError = coreGit.validateBranchName(branchName);
    if (validationError) {
      throw new Error(validationError);
    }

    const repoSessionNamespace = coreGit.getRepoSessionNamespace(repoRoot, this.backend);

    // Check if branch already exists (resume logic)
    const branchExists = await coreGit.localBranchExists(repoRoot, branchName);
    const savedWorker = this.findSavedWorkerForBranch(
      repoRoot,
      branchName,
      opts.preservedWorkerInfo,
      { includeArchive: !!opts.preservedWorkerInfo },
    );
    if (branchExists) {
      return this.resumeWorker(
        repoRoot,
        branchName,
        repoSessionNamespace,
        agentType,
        agentCommand,
        task,
        savedWorker,
        opts.copilotSessionName,
        opts.notifyCopilot !== false,
        opts.resumeSessionFile,
      );
    }

    const preservedWorker = opts.preservedWorkerInfo ? savedWorker : undefined;

    // Fetch latest from remote before creating worktree.
    // Registry-managed repos (~/.hydra/repos/...) demand an up-to-date mirror,
    // so we surface fetch failures instead of swallowing them silently.
    if (opts.fetchMode === 'required') {
      await coreGit.fetchOriginRequired(repoRoot);
    } else {
      await coreGit.fetchOrigin(repoRoot);
    }

    // Detect base branch
    const baseBranch = await coreGit.getBaseBranchFromRepo(repoRoot, opts.baseBranchOverride);

    // Warn if local base branch has commits ahead of remote
    const aheadCount = await coreGit.getLocalAheadCount(repoRoot, baseBranch);
    if (aheadCount > 0) {
      const localRef = baseBranch.startsWith('origin/') ? baseBranch.replace(/^origin\//, '') : baseBranch;
      console.warn(
        `[hydra] Warning: local "${localRef}" is ${aheadCount} commit(s) ahead of remote. ` +
        `Worktree will be based on the remote ref to ensure up-to-date code.`,
      );
    }

    // Slug collision resolution
    const slug = preservedWorker?.worker.slug || coreGit.branchNameToSlug(branchName, this.backend);
    let finalSlug = slug;
    let suffix = 1;
    while (await coreGit.isSlugTaken(finalSlug, repoSessionNamespace, repoRoot, this.backend)) {
      suffix++;
      finalSlug = `${slug}-${suffix}`;
    }

    // Create worktree
    const worktreePath = await coreGit.addWorktree(repoRoot, branchName, finalSlug, baseBranch);

    // On Windows, git converts symlinks to plain text files containing the target path.
    // Replace them with NTFS junctions so they work without admin privileges.
    fixWindowsSymlinks(worktreePath);

    let taskFilename: string | undefined;
    if (taskFile) {
      const absTaskFile = path.isAbsolute(taskFile) ? taskFile : path.resolve(taskFile);
      if (fs.existsSync(absTaskFile)) {
        taskFilename = path.basename(absTaskFile);
        const targetTaskFile = path.join(worktreePath, taskFilename);
        fs.copyFileSync(absTaskFile, targetTaskFile);

        // If no task prompt given, instruct agent to read the file
        if (!task) {
          task = `Read the task in \`${taskFilename}\` and implement it.`;
        }
      }
    }

    // Resolve @imports in instruction files
    this.resolveImports(path.join(worktreePath, 'CLAUDE.md'), repoRoot);
    this.resolveImports(path.join(worktreePath, 'AGENTS.md'), repoRoot);
    this.resolveImports(path.join(worktreePath, 'GEMINI.md'), repoRoot);

    // Create tmux session + set metadata
    const sessionName = preservedWorker?.worker.sessionName && preservedWorker.worker.slug === finalSlug
      ? preservedWorker.worker.sessionName
      : this.backend.buildSessionName(repoSessionNamespace, finalSlug);
    const copilotSessionName = opts.copilotSessionName;
    const shouldNotifyCopilot = agentSupportsCompletionNotification(agentType) &&
      opts.notifyCopilot !== false &&
      !!copilotSessionName &&
      !!(task || taskFile);
    if (shouldNotifyCopilot) {
      const peekState = this.readSessionState();
      const workerId = peekState.workers[sessionName]?.workerId ??
        preservedWorker?.worker.workerId ??
        peekState.nextWorkerId;
      this.injectCompletionHook(worktreePath, agentType, {
        copilotSessionName,
        sessionName,
        workerId,
        displayName: finalSlug,
        branch: branchName,
      });
      if (agentType === 'codex') {
        const scriptPath = path.join(getHydraHome(), 'hooks', `notify-${sessionName}.sh`);
        agentCommand = this.withCodexCompletionHookOverrides(agentCommand, repoRoot, scriptPath);
      }
    }

    await this.backend.createSession(sessionName, worktreePath);
    await this.backend.setSessionWorkdir(sessionName, worktreePath);
    await this.backend.setSessionRole(sessionName, 'worker');
    await this.backend.setSessionAgent(sessionName, agentType);

    // ── Launch agent ──
    //
    // Two distinct paths — resume (from archive) vs fresh create:
    //
    // Resume: session ID already known, launch with --resume, skip Phase 1.
    // Fresh: supported agents converge to sessionId stored in sessions.json:
    //   - Claude: pre-assigned via --session-id flag (known immediately)
    //   - Codex:  launch → wait for ready → send /status → parse session ID
    //   - Gemini: launch → wait for ready → send /stats → parse session ID
    //   - Sudo Code: launch → wait for ready → parse startup banner or /status
    const isResume = !!opts.resumeSessionId;
    let sessionId: string | null;
    let launchStartedAt: number | undefined;

    if (isResume) {
      sessionId = opts.resumeSessionId!;
      await this.launchAgentResume(sessionName, agentType, agentCommand, sessionId, worktreePath, opts.resumeSessionFile);
    } else {
      sessionId = agentType === 'claude' ? randomUUID() : null;
      const launchCmd = buildAgentLaunchCommand(agentType, agentCommand, undefined, sessionId ?? undefined);
      launchStartedAt = Date.now();
      await this.backend.sendKeys(sessionName, launchCmd);
    }

    // Write initial state to sessions.json
    // (sessionId may be null for Codex/Gemini until Phase 1 capture completes)
    const workerInfo = await this.updateSessionState((state) => {
      const now = new Date().toISOString();
      if (preservedWorker?.stateKey && preservedWorker.stateKey !== sessionName) {
        delete state.workers[preservedWorker.stateKey];
      }

      const existingWorker = state.workers[sessionName] || preservedWorker?.worker;
      const workerId = existingWorker?.workerId ?? state.nextWorkerId++;

      const nextWorker: WorkerInfo = {
        sessionName,
        displayName: finalSlug,
        workerId,
        repo: coreGit.getRepoName(repoRoot),
        repoRoot,
        branch: branchName,
        slug: finalSlug,
        status: 'running',
        attached: false,
        agent: agentType,
        workdir: worktreePath,
        tmuxSession: sessionName,
        createdAt: existingWorker?.createdAt ?? now,
        lastSeenAt: now,
        sessionId: sessionId ?? existingWorker?.sessionId ?? null,
        agentSessionFile: opts.resumeSessionFile ?? existingWorker?.agentSessionFile ?? null,
        copilotSessionName: opts.copilotSessionName ?? existingWorker?.copilotSessionName ?? null,
      };

      state.workers[sessionName] = nextWorker;
      state.updatedAt = now;
      return nextWorker;
    });

    // Async post-create
    const postCreatePromise = this.withPostCreateTimeout((async () => {
      if (isResume) {
        // Resume: skip Phase 1 (sessionId already known), just wait for readiness
        await this.waitForAgentReady(sessionName, agentType);
      } else {
        // Phase 1: Wait for readiness & capture session ID into sessions.json
        await this.waitForReadyAndCaptureSessionId(sessionName, agentType, sessionId, worktreePath, launchStartedAt);
      }
      // Phase 2: Send task prompt (only after sessions.json is up to date)
      await this.sendInitialPrompt(sessionName, task, shouldNotifyCopilot);
    })(), sessionName, 'worker startup');

    return { workerInfo, postCreatePromise };
  }

  async deleteWorker(sessionName: string): Promise<void> {
    await this.killSessionOrConfirmAbsent(sessionName);

    const worker = this.readSessionState().workers[sessionName];
    const archivedWorker = worker ? this.prepareArchivedSessionData(worker) as WorkerInfo : undefined;

    if (worker && worker.workdir && worker.repoRoot && fs.existsSync(worker.workdir)) {
      try {
        await coreGit.removeWorktree(worker.repoRoot, worker.workdir);
      } catch (error) {
        await this.updateSessionState((state) => {
          if (state.workers[sessionName]) {
            state.workers[sessionName].status = 'stopped';
            state.workers[sessionName].attached = false;
            state.updatedAt = new Date().toISOString();
          }
        });
        throw error;
      }

      if (worker.branch) {
        try {
          await exec(`git branch -D ${shellQuote(worker.branch)}`, { cwd: worker.repoRoot });
        } catch { /* Branch may not exist */ }
      }
    }

    // Archive only after destructive cleanup has succeeded, so failed deletes remain retryable.
    if (archivedWorker) {
      this.archiveEntry('worker', archivedWorker.sessionName, archivedWorker.sessionId, archivedWorker);
    }

    await this.updateSessionState((state) => {
      if (state.workers[sessionName]) {
        delete state.workers[sessionName];
        state.updatedAt = new Date().toISOString();
      }
    });
  }

  async stopWorker(sessionName: string): Promise<void> {
    try {
      await this.backend.killSession(sessionName);
    } catch { /* Already dead */ }

    await this.updateSessionState((state) => {
      if (state.workers[sessionName]) {
        state.workers[sessionName].status = 'stopped';
        state.workers[sessionName].attached = false;
        state.updatedAt = new Date().toISOString();
      }
    });
  }

  async startWorker(sessionName: string, agentType?: string, agentCommand?: string): Promise<CreateWorkerResult> {
    const existingWorker = this.readSessionState().workers[sessionName];
    if (!existingWorker) {
      throw new Error(`Worker "${sessionName}" not found in sessions.json`);
    }

    if (!existingWorker.workdir || !fs.existsSync(existingWorker.workdir)) {
      throw new Error(`Worktree "${existingWorker.workdir}" does not exist`);
    }

    const agent = agentType || existingWorker.agent || 'claude';
    const command = await this.resolveAgentCommand(agentCommand || this.getDefaultAgentCommand(agent));

    await this.backend.createSession(sessionName, existingWorker.workdir);
    await this.backend.setSessionWorkdir(sessionName, existingWorker.workdir);
    await this.backend.setSessionRole(sessionName, 'worker');
    await this.backend.setSessionAgent(sessionName, agent);

    // Resume from stored session ID if available; otherwise fresh start
    const storedSessionId = existingWorker.sessionId;
    const resolvedResumeSessionFile = storedSessionId
      ? resolveAgentSessionFile(agent, existingWorker.workdir, storedSessionId, existingWorker.agentSessionFile)
      : null;
    const canResume = !!storedSessionId &&
      (agent !== 'sudocode' || !!resolvedResumeSessionFile) &&
      !!buildAgentResumePlan(
        agent,
        command,
        storedSessionId,
        existingWorker.workdir,
        resolvedResumeSessionFile,
      );

    let workerInfo: WorkerInfo;
    let postCreatePromise: Promise<void>;

    if (canResume && storedSessionId) {
      // ── Resume flow: launch agent resume, no session ID capture needed ──
      // The agent already has its conversation context; just restart it.
      await this.launchAgentResume(
        sessionName,
        agent,
        command,
        storedSessionId,
        existingWorker.workdir,
        resolvedResumeSessionFile,
      );
      workerInfo = await this.updateSessionState((currentState) => {
        const currentWorker = currentState.workers[sessionName];
        if (!currentWorker) {
          throw new Error(`Worker "${sessionName}" not found in sessions.json`);
        }

        currentWorker.status = 'running';
        currentWorker.attached = false;
        currentWorker.agent = agent;
        currentWorker.agentSessionFile = resolvedResumeSessionFile ?? existingWorker.agentSessionFile ?? currentWorker.agentSessionFile ?? null;
        currentWorker.lastSeenAt = new Date().toISOString();
        currentState.updatedAt = currentWorker.lastSeenAt;
        return { ...currentWorker };
      });
      // Wait for the resumed TUI to reach its idle prompt so follow-up CLI
      // commands can run immediately without racing the agent startup.
      postCreatePromise = this.waitForAgentReady(sessionName, agent);
    } else {
      // ── Fresh start: Phase 1 (capture sessionId) ──
      // No stored session ID — launch fresh agent and capture new session ID.
      const preAssignedSessionId = agent === 'claude' ? randomUUID() : null;
      const launchCmd = buildAgentLaunchCommand(agent, command, undefined, preAssignedSessionId ?? undefined);
      const launchStartedAt = Date.now();
      await this.backend.sendKeys(sessionName, launchCmd);

      workerInfo = await this.updateSessionState((currentState) => {
        const currentWorker = currentState.workers[sessionName];
        if (!currentWorker) {
          throw new Error(`Worker "${sessionName}" not found in sessions.json`);
        }

        currentWorker.status = 'running';
        currentWorker.attached = false;
        currentWorker.agent = agent;
        currentWorker.sessionId = preAssignedSessionId;
        currentWorker.agentSessionFile = null;
        currentWorker.lastSeenAt = new Date().toISOString();
        currentState.updatedAt = currentWorker.lastSeenAt;
        return { ...currentWorker };
      });

      // Phase 1 only — startWorker is a restart, no task to send (Phase 2 skipped)
      postCreatePromise = this.waitForReadyAndCaptureSessionId(
        sessionName,
        agent,
        preAssignedSessionId,
        existingWorker.workdir,
        launchStartedAt,
      );
    }

    return {
      workerInfo,
      postCreatePromise: this.withPostCreateTimeout(postCreatePromise, sessionName, 'worker startup'),
    };
  }

  // ── Copilot Lifecycle ──

  async createCopilot(opts: CreateCopilotOpts): Promise<CreateCopilotResult> {
    ensureHydraGlobalConfig();

    const agentType = opts.agentType || 'claude';
    const agentCommand = await this.resolveAgentCommand(opts.agentCommand || this.getDefaultAgentCommand(agentType));
    const displayName = opts.name || opts.sessionName || `hydra-copilot-${agentType}`;
    const sessionName = opts.sessionName || this.backend.sanitizeSessionName(`hydra-copilot-${agentType}`);

    const exists = await this.backend.hasSession(sessionName);
    if (exists) {
      throw new Error(`Session "${sessionName}" already exists`);
    }

    await this.backend.createSession(sessionName, opts.workdir);
    await this.backend.setSessionWorkdir(sessionName, opts.workdir);
    await this.backend.setSessionRole(sessionName, 'copilot');
    await this.backend.setSessionAgent(sessionName, agentType);

    // ── Launch agent ──
    // Same two paths as createWorker: resume vs fresh.
    const isResume = !!opts.resumeSessionId;
    let sessionId: string | null;
    let launchStartedAt: number | undefined;

    let postCreatePromise = Promise.resolve();

    if (isResume) {
      sessionId = opts.resumeSessionId!;
      await this.launchAgentResume(sessionName, agentType, agentCommand, sessionId, opts.workdir, opts.resumeSessionFile);
    } else {
      sessionId = agentType === 'claude' ? randomUUID() : null;
      const launchCmd = buildAgentLaunchCommand(agentType, agentCommand, undefined, sessionId ?? undefined);
      launchStartedAt = Date.now();
      await this.backend.sendKeys(sessionName, launchCmd);
    }

    // Write initial state to sessions.json
    const now = new Date().toISOString();
    const copilotInfo: CopilotInfo = {
      sessionName,
      displayName,
      status: 'running',
      attached: false,
      agent: agentType,
      workdir: opts.workdir,
      tmuxSession: sessionName,
      createdAt: now,
      lastSeenAt: now,
      sessionId,
      agentSessionFile: opts.resumeSessionFile ?? null,
    };

    const persistedCopilotInfo = await this.updateSessionState((state) => {
      const existingCopilot = state.copilots[sessionName];
      const nextCopilot: CopilotInfo = {
        ...copilotInfo,
        createdAt: existingCopilot?.createdAt ?? now,
        sessionId: sessionId ?? existingCopilot?.sessionId ?? null,
        agentSessionFile: opts.resumeSessionFile ?? existingCopilot?.agentSessionFile ?? null,
      };

      state.copilots[sessionName] = nextCopilot;
      state.updatedAt = now;
      return nextCopilot;
    });

    // Match worker lifecycle semantics: wait for readiness and persist any deferred
    // session ID capture before the CLI treats creation as complete.
    postCreatePromise = this.withPostCreateTimeout(
      this.waitForReadyAndCaptureSessionId(sessionName, agentType, sessionId, opts.workdir, launchStartedAt),
      sessionName,
      'copilot startup',
    );

    return { copilotInfo: persistedCopilotInfo, postCreatePromise };
  }

  async createCopilotAndFinalize(opts: CreateCopilotOpts): Promise<CopilotInfo> {
    return this.finalizeCopilotResult(await this.createCopilot(opts));
  }

  async restoreCopilotAndFinalize(sessionName: string): Promise<CopilotInfo> {
    return this.finalizeCopilotResult(await this.restoreCopilot(sessionName));
  }

  async renameWorker(oldSessionName: string, newBranchName: string): Promise<WorkerInfo> {
    const state = this.readSessionState();
    const worker = state.workers[oldSessionName];
    if (!worker) {
      throw new Error(`Worker "${oldSessionName}" not found`);
    }

    if (!worker.repoRoot) {
      throw new Error(`Worker "${oldSessionName}" has no associated repository`);
    }

    // Validate new branch name
    const validationError = coreGit.validateBranchName(newBranchName);
    if (validationError) {
      throw new Error(validationError);
    }

    // Derive new slug, session name, worktree path
    const repoSessionNamespace = coreGit.getRepoSessionNamespace(worker.repoRoot, this.backend);
    const newSlug = coreGit.branchNameToSlug(newBranchName, this.backend);
    const newSessionName = this.backend.buildSessionName(repoSessionNamespace, newSlug);
    const worktreesDir = coreGit.getManagedRepoWorktreesDir(worker.repoRoot);
    const newWorktreePath = path.join(worktreesDir, newSlug);

    // Check conflicts
    if (newSessionName !== oldSessionName && (state.workers[newSessionName] || state.copilots[newSessionName])) {
      throw new Error(`Session "${newSessionName}" already exists`);
    }
    if (await coreGit.localBranchExists(worker.repoRoot, newBranchName)) {
      throw new Error(`Branch "${newBranchName}" already exists`);
    }

    // 1. Rename git branch
    if (worker.branch) {
      await exec(
        `git branch -m ${shellQuote(worker.branch)} ${shellQuote(newBranchName)}`,
        { cwd: worker.repoRoot },
      );

      // Update vscode-merge-base config
      try {
        const baseBranch = await exec(
          `git config ${shellQuote(`branch.${worker.branch}.vscode-merge-base`)}`,
          { cwd: worker.repoRoot },
        );
        if (baseBranch.trim()) {
          await exec(
            `git config ${shellQuote(`branch.${newBranchName}.vscode-merge-base`)} ${shellQuote(baseBranch.trim())}`,
            { cwd: worker.repoRoot },
          );
        }
      } catch {
        // No vscode-merge-base config — skip
      }
      try {
        await exec(
          `git config --unset ${shellQuote(`branch.${worker.branch}.vscode-merge-base`)}`,
          { cwd: worker.repoRoot },
        );
      } catch {
        // Already absent — skip
      }
    }

    // 2. Move worktree directory (if it's a managed worktree and slug changed)
    if (worker.workdir && newSlug !== worker.slug && fs.existsSync(worker.workdir)) {
      await exec(
        `git worktree move ${shellQuote(worker.workdir)} ${shellQuote(newWorktreePath)}`,
        { cwd: worker.repoRoot },
      );
    }

    // 3. Rename tmux session (if running and name changed)
    if (newSessionName !== oldSessionName) {
      const hasLive = await this.backend.hasSession(oldSessionName);
      if (hasLive) {
        await this.backend.renameSession(oldSessionName, newSessionName);

        // Update @workdir metadata if worktree moved
        if (newSlug !== worker.slug) {
          await this.backend.setSessionWorkdir(newSessionName, newWorktreePath);
        }
      }
    }

    return this.updateSessionState((currentState) => {
      const currentWorker = currentState.workers[oldSessionName];
      if (!currentWorker) {
        throw new Error(`Worker "${oldSessionName}" not found`);
      }

      const oldWorkdir = currentWorker.workdir;
      const oldAgentSessionFile = currentWorker.agentSessionFile ?? null;
      const worktreeMoved = newSlug !== currentWorker.slug && fs.existsSync(newWorktreePath);
      delete currentState.workers[oldSessionName];
      currentWorker.sessionName = newSessionName;
      currentWorker.displayName = newSlug;
      currentWorker.tmuxSession = newSessionName;
      currentWorker.branch = newBranchName;
      currentWorker.slug = newSlug;
      if (worktreeMoved) {
        currentWorker.workdir = newWorktreePath;
        if (currentWorker.agent === 'sudocode') {
          currentWorker.sessionId = null;
          currentWorker.agentSessionFile = null;
        } else {
          const rebasedSessionFile = rebasePathUnderDirectory(oldAgentSessionFile, oldWorkdir, newWorktreePath);
          currentWorker.agentSessionFile = (rebasedSessionFile && fs.existsSync(rebasedSessionFile))
            ? rebasedSessionFile
            : resolveAgentSessionFile(currentWorker.agent, newWorktreePath, currentWorker.sessionId, null) ?? oldAgentSessionFile;
        }
      }
      currentState.workers[newSessionName] = currentWorker;
      currentState.updatedAt = new Date().toISOString();
      return { ...currentWorker };
    });
  }

  async renameCopilot(oldSessionName: string, newSessionName: string): Promise<CopilotInfo> {
    const state = this.readSessionState();
    const copilot = state.copilots[oldSessionName];
    if (!copilot) {
      throw new Error(`Copilot "${oldSessionName}" not found`);
    }

    // Validate new name
    const sanitized = this.backend.sanitizeSessionName(newSessionName);
    if (!sanitized) {
      throw new Error('New session name is invalid');
    }

    // Check conflict
    if (state.copilots[newSessionName] || state.workers[newSessionName]) {
      throw new Error(`Session "${newSessionName}" already exists`);
    }

    // Rename live tmux session (copilots are always running)
    const hasLive = await this.backend.hasSession(oldSessionName);
    if (hasLive) {
      await this.backend.renameSession(oldSessionName, newSessionName);
    }

    return this.updateSessionState((currentState) => {
      const currentCopilot = currentState.copilots[oldSessionName];
      if (!currentCopilot) {
        throw new Error(`Copilot "${oldSessionName}" not found`);
      }

      delete currentState.copilots[oldSessionName];
      currentCopilot.sessionName = newSessionName;
      currentCopilot.displayName = newSessionName;
      currentCopilot.tmuxSession = newSessionName;
      currentState.copilots[newSessionName] = currentCopilot;
      for (const worker of Object.values(currentState.workers)) {
        if (worker.copilotSessionName === oldSessionName) {
          worker.copilotSessionName = newSessionName;
        }
      }
      currentState.updatedAt = new Date().toISOString();
      return { ...currentCopilot };
    });
  }

  async deleteCopilot(sessionName: string): Promise<void> {
    try {
      await this.backend.killSession(sessionName);
    } catch { /* Already dead */ }

    const copilot = this.readSessionState().copilots[sessionName];
    const archivedCopilot = copilot ? this.prepareArchivedSessionData(copilot) as CopilotInfo : undefined;

    // Archive before removing
    if (archivedCopilot) {
      this.archiveEntry('copilot', archivedCopilot.sessionName, archivedCopilot.sessionId, archivedCopilot);
    }

    await this.updateSessionState((state) => {
      if (state.copilots[sessionName]) {
        delete state.copilots[sessionName];
        state.updatedAt = new Date().toISOString();
      }
    });
  }

  // ── Public helpers for VS Code extension ──

  /**
   * Persist a copilot entry to sessions.json with pre-assigned session ID.
   * Called by the VS Code extension which creates sessions directly via backend.
   */
  async persistCopilotSessionId(
    sessionName: string,
    agentType: string,
    workdir: string,
    sessionId: string | null,
    displayName?: string,
  ): Promise<void> {
    await this.updateSessionState((state) => {
      const now = new Date().toISOString();
      const existingCopilot = state.copilots[sessionName];
      state.copilots[sessionName] = {
        sessionName,
        displayName: displayName || existingCopilot?.displayName || sessionName,
        status: 'running',
        attached: false,
        agent: agentType,
        workdir,
        tmuxSession: sessionName,
        createdAt: existingCopilot?.createdAt ?? now,
        lastSeenAt: now,
        sessionId: sessionId ?? existingCopilot?.sessionId ?? null,
        agentSessionFile: existingCopilot?.agentSessionFile ?? null,
      };
      state.updatedAt = now;
    });
  }

  /**
   * Capture session ID via slash command and persist to sessions.json.
   * Used by VS Code extension for Codex/Gemini copilots.
   */
  async captureAndPersistSessionId(sessionName: string, agentType: string): Promise<void> {
    const state = this.readSessionState();
    const saved = state.workers[sessionName] || state.copilots[sessionName];
    const workdir = saved?.workdir || await this.backend.getSessionWorkdir(sessionName) || '';
    const session = await this.captureAgentSessionInfo(sessionName, agentType, workdir);
    await this.updateAgentSessionInfo(sessionName, session.sessionId, session.agentSessionFile);
  }

  // ── Archive ──

  listArchived(): ArchivedSessionInfo[] {
    return this.readArchiveState().entries;
  }

  getArchivedAll(sessionName: string): ArchivedSessionInfo[] {
    return this.readArchiveState().entries.filter(e => e.sessionName === sessionName);
  }

  getArchived(sessionName: string): ArchivedSessionInfo | undefined {
    const all = this.getArchivedAll(sessionName);
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  listArchivedLatest(): ArchivedSessionInfo[] {
    const entries = this.readArchiveState().entries;
    const latest = new Map<string, ArchivedSessionInfo>();
    for (const entry of entries) {
      latest.set(entry.sessionName, entry);
    }
    return [...latest.values()];
  }

  async restoreWorker(sessionName: string): Promise<CreateWorkerResult> {
    const entry = this.getArchived(sessionName);
    if (!entry) {
      throw new Error(`Archived session "${sessionName}" not found`);
    }
    if (entry.type !== 'worker') {
      throw new Error(`Archived session "${sessionName}" is a copilot, not a worker`);
    }

    const worker = entry.data as WorkerInfo;
    return this.createWorker({
      repoRoot: worker.repoRoot,
      branchName: worker.branch,
      agentType: worker.agent,
      resumeSessionId: entry.agentSessionId || undefined,
      resumeSessionFile: entry.agentSessionFile || worker.agentSessionFile || undefined,
      preservedWorkerInfo: worker,
    });
  }

  async restoreCopilot(sessionName: string): Promise<CreateCopilotResult> {
    const entry = this.getArchived(sessionName);
    if (!entry) {
      throw new Error(`Archived session "${sessionName}" not found`);
    }
    if (entry.type !== 'copilot') {
      throw new Error(`Archived session "${sessionName}" is a worker, not a copilot`);
    }

    const copilot = entry.data as CopilotInfo;
    return this.createCopilot({
      workdir: copilot.workdir,
      agentType: copilot.agent,
      name: copilot.displayName,
      sessionName: copilot.sessionName,
      resumeSessionId: entry.agentSessionId || undefined,
      resumeSessionFile: entry.agentSessionFile || copilot.agentSessionFile || undefined,
    });
  }

  // ── Private helpers ──

  private async finalizeCopilotResult(result: CreateCopilotResult): Promise<CopilotInfo> {
    await result.postCreatePromise;
    const state = await this.sync();
    return state.copilots[result.copilotInfo.sessionName] || result.copilotInfo;
  }

  private withPostCreateTimeout(
    promise: Promise<void>,
    sessionName: string,
    operation: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${operation} for "${sessionName}" after ${POST_CREATE_TIMEOUT_MS}ms`));
      }, POST_CREATE_TIMEOUT_MS);

      promise.then(
        () => {
          clearTimeout(timeoutId);
          resolve();
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private async killSessionOrConfirmAbsent(sessionName: string): Promise<void> {
    try {
      await this.backend.killSession(sessionName);
      return;
    } catch (error) {
      let hasLiveSession: boolean;
      try {
        hasLiveSession = await this.backend.hasSession(sessionName);
      } catch {
        throw error;
      }

      if (!hasLiveSession) {
        return;
      }

      throw error;
    }
  }

  private archiveEntry(
    type: 'worker' | 'copilot',
    sessionName: string,
    agentSessionId: string | null,
    data: WorkerInfo | CopilotInfo,
  ): void {
    const archive = this.readArchiveState();
    archive.entries.push({
      type,
      sessionName,
      agentSessionId,
      agentSessionFile: data.agentSessionFile ?? null,
      archivedAt: new Date().toISOString(),
      data: { ...data },
    });
    this.writeArchiveState(archive);
  }

  private prepareArchivedSessionData(data: WorkerInfo | CopilotInfo): WorkerInfo | CopilotInfo {
    if (data.agent !== 'sudocode') {
      return { ...data };
    }

    const sessionFile = resolveAgentSessionFile(
      data.agent,
      data.workdir,
      data.sessionId,
      data.agentSessionFile ?? null,
    );
    if (!sessionFile) {
      return { ...data, agentSessionFile: data.agentSessionFile ?? null };
    }

    try {
      const archiveDir = path.join(getHydraHome(), 'agent-sessions', 'sudocode', data.sessionName);
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivedFile = path.join(archiveDir, path.basename(sessionFile));
      fs.copyFileSync(sessionFile, archivedFile);
      return { ...data, agentSessionFile: archivedFile };
    } catch {
      return { ...data, agentSessionFile: sessionFile };
    }
  }

  private readArchiveState(): ArchiveState {
    const archiveFile = getHydraArchiveFile();
    try {
      if (fs.existsSync(archiveFile)) {
        const raw = fs.readFileSync(archiveFile, 'utf-8');
        const parsed = JSON.parse(raw);
        return { entries: parsed.entries || [] };
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { entries: [] };
  }

  private writeArchiveState(archive: ArchiveState): void {
    const archiveFile = getHydraArchiveFile();
    this.writeJsonAtomically(archiveFile, JSON.stringify(archive, null, 2));
  }

  private readSessionState(): SessionState {
    const sessionsFile = getHydraSessionsFile();
    try {
      if (fs.existsSync(sessionsFile)) {
        const raw = fs.readFileSync(sessionsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const state: SessionState = {
          copilots: parsed.copilots || {},
          workers: parsed.workers || {},
          nextWorkerId: parsed.nextWorkerId || 1,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
        // Backward compat: ensure sessionId and displayName fields exist for legacy entries
        for (const w of Object.values(state.workers)) {
          w.sessionId ??= null;
          w.agentSessionFile ??= null;
          w.displayName ??= w.slug || this.extractSlugFromSessionName(w.sessionName);
        }
        for (const c of Object.values(state.copilots)) {
          c.sessionId ??= null;
          c.agentSessionFile ??= null;
          c.displayName ??= c.sessionName;
        }
        return state;
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { copilots: {}, workers: {}, nextWorkerId: 1, updatedAt: new Date().toISOString() };
  }

  private writeSessionState(state: SessionState): void {
    const sessionsFile = getHydraSessionsFile();
    this.writeJsonAtomically(sessionsFile, JSON.stringify(state, null, 2));
  }

  private async updateSessionState<T>(mutate: (state: SessionState) => T): Promise<T> {
    const release = await this.acquireSessionStateLock();
    try {
      const state = this.readSessionState();
      const result = mutate(state);
      this.writeSessionState(state);
      return result;
    } finally {
      await release();
    }
  }

  private async acquireSessionStateLock(): Promise<() => Promise<void>> {
    const sessionsFile = getHydraSessionsFile();
    const hydraHome = getHydraHome();
    if (!fs.existsSync(hydraHome)) {
      fs.mkdirSync(hydraHome, { recursive: true });
    }

    const lockFile = `${sessionsFile}.lock`;
    const deadline = Date.now() + SESSION_STATE_LOCK_TIMEOUT_MS;

    while (true) {
      try {
        const handle = await fs.promises.open(lockFile, 'wx');
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
            'utf-8',
          );
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }

        return async () => {
          try {
            await handle.close();
          } finally {
            try {
              await fs.promises.unlink(lockFile);
            } catch {
              // Best-effort cleanup
            }
          }
        };
      } catch (error) {
        const err = error as { code?: string };
        if (err.code !== 'EEXIST') {
          throw error;
        }

        if (this.isSessionStateLockStale(lockFile)) {
          try {
            fs.unlinkSync(lockFile);
            continue;
          } catch (unlinkError) {
            const unlinkErr = unlinkError as { code?: string };
            if (unlinkErr.code === 'ENOENT') {
              continue;
            }
            throw unlinkError;
          }
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for sessions lock: ${lockFile}`);
        }

        await this.sleep(SESSION_STATE_LOCK_RETRY_MS);
      }
    }
  }

  private isSessionStateLockStale(lockFile: string): boolean {
    try {
      const stat = fs.statSync(lockFile);
      return (Date.now() - stat.mtimeMs) > SESSION_STATE_LOCK_STALE_MS;
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private writeJsonAtomically(filePath: string, contents: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempFile = path.join(
      dir,
      `${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );

    try {
      fs.writeFileSync(tempFile, contents, 'utf-8');
      fs.renameSync(tempFile, filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Best-effort cleanup
      }
      throw error;
    }
  }

  /**
   * Resolve @imports: for each line in a file, if it starts with @<path>,
   * replace it with the contents of <repoRoot>/<path>.
   */
  private resolveImports(filePath: string, repoRoot: string): void {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let changed = false;
    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('@') && !trimmed.startsWith('@{')) {
        const importPath = trimmed.substring(1);
        const absPath = path.resolve(repoRoot, importPath);
        if (fs.existsSync(absPath)) {
          result.push(fs.readFileSync(absPath, 'utf-8'));
          changed = true;
          continue;
        }
      }
      result.push(line);
    }

    if (changed) {
      fs.writeFileSync(filePath, result.join('\n'), 'utf-8');
    }
  }

  /**
   * ── Phase 1: Capture session ID ──
   *
   * Wait for agent readiness and ensure the agent's session ID is in sessions.json.
   * This is the convergence point for all 3 agents:
   *
   * - Claude: sessionId pre-assigned via --session-id flag → just wait for TUI readiness
   * - Codex: wait for readiness, send /status, parse session ID from output
   * - Gemini: wait for readiness, send /stats, parse session ID from output
   *
   * After this method completes, sessions.json has the definitive sessionId.
   * Skipped entirely on resume (sessionId already stored from the original create).
   */
  private async waitForReadyAndCaptureSessionId(
    sessionName: string,
    agentType: string,
    preAssignedSessionId: string | null,
    workdir: string,
    launchStartedAt?: number,
  ): Promise<void> {
    if (preAssignedSessionId) {
      // Claude (or resume): sessionId already known — just wait for TUI readiness
      await this.waitForAgentReady(sessionName, agentType);
    } else {
      // Codex/Gemini/Sudo Code: capture sessionId via slash command or startup banner
      const session = await this.captureAgentSessionInfo(sessionName, agentType, workdir, launchStartedAt);
      await this.updateAgentSessionInfo(sessionName, session.sessionId, session.agentSessionFile);
    }
  }

  /**
   * Send the initial task prompt to the agent.
   * Only called after waitForReadyAndCaptureSessionId completes
   * (i.e., sessions.json has the definitive sessionId).
   *
   * - Workers: send the task prompt (provided by copilot or --task flag)
   * - Copilots: VS Code extension sends onboarding prompt separately
   */
  private async sendInitialPrompt(
    sessionName: string,
    task?: string,
    notifyCopilot = false,
  ): Promise<void> {
    if (task) {
      if (notifyCopilot) {
        this.armCompletionNotification(sessionName);
      }
      await this.backend.sendMessage(sessionName, task);
    }
  }

  // ── Completion hook injection ──

  /**
   * Metadata needed to build the completion notification hook.
   * Gathered before updateSessionState so the hook is in place before the agent starts.
   */
  private injectCompletionHook(
    worktreePath: string,
    agentType: string,
    info: {
      copilotSessionName: string;
      sessionName: string;
      workerId: number;
      displayName: string;
      branch: string;
    },
  ): void {
    if (!agentSupportsCompletionNotification(agentType)) {
      return;
    }

    try {
      // 1. Write the notification shell script
      const hooksDir = path.join(getHydraHome(), 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const scriptPath = path.join(hooksDir, `notify-${info.sessionName}.sh`);
      fs.writeFileSync(scriptPath, this.buildNotifyScript(info), { mode: 0o755 });

      const hookCommand = this.buildNotifyHookCommand(scriptPath, agentType);

      // 2. Merge the completion hook into the agent's config
      switch (agentType) {
        case 'claude':
          this.mergeAgentHookConfig(
            path.join(worktreePath, '.claude', 'settings.json'),
            'Stop',
            { hooks: [{ type: 'command', command: hookCommand, async: true }] },
          );
          break;
        case 'codex':
          this.mergeAgentHookConfig(
            path.join(worktreePath, '.codex', 'hooks.json'),
            'Stop',
            { hooks: [{ type: 'command', command: hookCommand }] },
          );
          // Codex requires the codex_hooks feature flag to be enabled
          this.ensureCodexHooksEnabled(path.join(worktreePath, '.codex', 'config.toml'));
          break;
        case 'gemini':
          this.mergeAgentHookConfig(
            path.join(worktreePath, '.gemini', 'settings.json'),
            'AfterAgent',
            {
              matcher: '*',
              hooks: [{
                name: 'hydra-notify-copilot',
                type: 'command',
                command: hookCommand,
                timeout: 5000,
              }],
            },
          );
          break;
        // custom: no known hook system — skip
      }
    } catch {
      // Best-effort — don't fail worker creation if hook injection fails
    }
  }

  private mergeAgentHookConfig(
    configPath: string,
    eventName: string,
    hookEntry: Record<string, unknown>,
  ): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let config: any = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch { /* start fresh */ }

    if (!config.hooks) config.hooks = {};
    if (!Array.isArray(config.hooks[eventName])) config.hooks[eventName] = [];
    config.hooks[eventName].push(hookEntry);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  private ensureCodexHooksEnabled(configTomlPath: string): void {
    fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });

    const featureLine = 'codex_hooks = true';
    const content = fs.existsSync(configTomlPath)
      ? fs.readFileSync(configTomlPath, 'utf-8')
      : '';
    if (/^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/m.test(content)) {
      return;
    }

    const lines = content ? content.split(/\r?\n/) : [];
    let featuresStart = -1;
    let featuresEnd = lines.length;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[features\]\s*(?:#.*)?$/.test(lines[i])) {
        featuresStart = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[j])) {
            featuresEnd = j;
            break;
          }
        }
        break;
      }
    }

    if (featuresStart >= 0) {
      for (let i = featuresStart + 1; i < featuresEnd; i++) {
        if (/^\s*codex_hooks\s*=/.test(lines[i])) {
          lines[i] = featureLine;
          fs.writeFileSync(configTomlPath, lines.join('\n').replace(/\n*$/, '\n'), 'utf-8');
          return;
        }
      }
      lines.splice(featuresStart + 1, 0, featureLine);
      fs.writeFileSync(configTomlPath, lines.join('\n').replace(/\n*$/, '\n'), 'utf-8');
      return;
    }

    const prefix = content.trimEnd();
    const nextContent = (prefix ? `${prefix}\n\n` : '') + `[features]\n${featureLine}\n`;
    fs.writeFileSync(configTomlPath, nextContent, 'utf-8');
  }

  private buildNotifyHookCommand(scriptPath: string, agentType: string): string {
    const command = `sh ${shellQuote(scriptPath)}`;
    switch (agentType) {
      case 'codex':
        // Codex Stop hooks expect JSON on stdout. The notification remains
        // best-effort, and the hook command reports a successful no-op payload.
        return `${command} >/dev/null; printf '{}'`;
      case 'gemini':
        // Gemini hooks expect JSON on stdout. The notification remains
        // best-effort, and the hook command reports a successful no-op payload.
        return `${command} >/dev/null; printf '{}'`;
      default:
        return command;
    }
  }

  private withCodexCompletionHookOverrides(agentCommand: string, repoRoot: string, scriptPath: string): string {
    const trustRoots = new Set([repoRoot]);
    try {
      trustRoots.add(fs.realpathSync(repoRoot));
    } catch {
      // Fall back to the original path when realpath is unavailable.
    }

    const projects = [...trustRoots]
      .map((trustRoot) => `${JSON.stringify(trustRoot)}={trust_level="trusted"}`)
      .join(',');
    const hookCommand = this.buildNotifyHookCommand(scriptPath, 'codex');
    const hooksConfig = [
      'hooks={Stop=[{hooks=[{',
      'type="command",',
      `command=${JSON.stringify(hookCommand)}`,
      '}]}]}',
    ].join('');

    return [
      agentCommand.trim(),
      '-c',
      shellQuote('features.codex_hooks=true'),
      '-c',
      shellQuote(`projects={${projects}}`),
      '-c',
      shellQuote(hooksConfig),
    ].join(' ');
  }

  private buildNotifyScript(info: {
    copilotSessionName: string;
    sessionName: string;
    workerId: number;
    displayName: string;
    branch: string;
  }): string {
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const pendingPath = this.getNotifyPendingPath(info.sessionName);
    return [
      '#!/bin/sh',
      '# Auto-generated by Hydra: parent copilot completion notification.',
      '',
      `COPILOT=${sq(info.copilotSessionName)}`,
      `SESSION=${sq(info.sessionName)}`,
      `WORKER_ID=${sq(String(info.workerId))}`,
      `NAME=${sq(info.displayName)}`,
      `BRANCH=${sq(info.branch)}`,
      `PENDING=${sq(pendingPath)}`,
      'LOCKDIR="${PENDING}.lock"',
      '',
      '# Only Hydra-armed copilot messages should notify on completion.',
      '[ -f "$PENDING" ] || exit 0',
      'if ! mkdir "$LOCKDIR" 2>/dev/null; then',
      '  exit 0',
      'fi',
      'cleanup() { rm -rf "$LOCKDIR"; }',
      'trap cleanup EXIT HUP INT TERM',
      '[ -f "$PENDING" ] || exit 0',
      '',
      '# Resolve tmux command (honors HYDRA_TMUX_SOCKET if set)',
      't=tmux',
      'if [ -n "$HYDRA_TMUX_SOCKET" ]; then',
      '  case "$HYDRA_TMUX_SOCKET" in',
      '    /*|./*|../*) t="tmux -S $HYDRA_TMUX_SOCKET" ;;',
      '    *) t="tmux -L $HYDRA_TMUX_SOCKET" ;;',
      '  esac',
      'fi',
      '',
      '# Only notify if copilot session still exists',
      '$t has-session -t "$COPILOT" 2>/dev/null || exit 0',
      '',
      'MSG="Worker #${WORKER_ID} (${NAME}) has completed. Branch: ${BRANCH}. Use \\`hydra worker logs ${SESSION}\\` to review output."',
      '',
      '# Use load-buffer/paste-buffer to avoid the Enter-swallow issue (see PR #122)',
      'f=$(mktemp) || exit 0',
      'printf \'%s\' "$MSG" > "$f"',
      'b="hydra-$$"',
      'if $t load-buffer -b "$b" "$f" 2>/dev/null \\',
      '  && $t paste-buffer -b "$b" -t "$COPILOT" -d 2>/dev/null \\',
      '  && sleep 0.1 \\',
      '  && $t send-keys -t "$COPILOT" Enter 2>/dev/null; then',
      '  rm -f "$PENDING"',
      'fi',
      'rm -f "$f"',
    ].join('\n') + '\n';
  }

  private getNotifyPendingPath(sessionName: string): string {
    return path.join(getHydraHome(), 'hooks', `notify-${sessionName}.pending`);
  }

  private async launchAgentResume(
    sessionName: string,
    agentType: string,
    agentCommand: string,
    sessionId: string,
    workdir: string,
    agentSessionFile?: string | null,
  ): Promise<void> {
    const resumePlan = buildAgentResumePlan(agentType, agentCommand, sessionId, workdir, agentSessionFile);
    if (!resumePlan) {
      throw new Error(`Agent "${agentType}" does not support session resume`);
    }

    await this.backend.sendKeys(sessionName, resumePlan.command);
    if (resumePlan.strategy === 'replSlashCommand') {
      await this.waitForAgentReady(sessionName, agentType);
      const beforeResume = await this.captureCleanPane(sessionName, 400);
      await this.backend.sendMessage(sessionName, resumePlan.slashCommand);
      await this.waitForReplSlashCommandReady(
        sessionName,
        agentType,
        resumePlan.slashCommand,
        beforeResume,
      );
    }
  }

  private async waitForReplSlashCommandReady(
    sessionName: string,
    agentType: string,
    slashCommand: string,
    beforeCommandOutput: string,
  ): Promise<void> {
    if (agentType === 'sudocode' && slashCommand.trim().startsWith('/resume')) {
      await this.waitForSudoCodeResumeReady(sessionName, beforeCommandOutput);
      return;
    }

    await this.waitForAgentReady(sessionName, agentType);
  }

  private async waitForSudoCodeResumeReady(
    sessionName: string,
    beforeResumeOutput: string,
  ): Promise<void> {
    const pattern = AGENT_READY_PATTERNS.sudocode;
    const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
    const marker = 'Session resumed';
    const beforeMarkerCount = countOccurrences(beforeResumeOutput, marker);

    await this.sleep(AGENT_READY_POLL_INTERVAL_MS);

    while (Date.now() < deadline) {
      try {
        const output = await this.captureCleanPane(sessionName, 400);
        let newOutput = '';
        if (output.startsWith(beforeResumeOutput)) {
          newOutput = output.slice(beforeResumeOutput.length);
        } else if (countOccurrences(output, marker) > beforeMarkerCount) {
          newOutput = output.slice(output.lastIndexOf(marker));
        }

        const markerIndex = newOutput.lastIndexOf(marker);
        if (markerIndex >= 0) {
          const afterMarker = newOutput.slice(markerIndex + marker.length);
          if (pattern.test(afterMarker)) {
            await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
            return;
          }
        }
      } catch {
        // Session may still be repainting after the slash command.
      }
      await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
    }
  }

  /**
   * Poll the tmux pane output until the agent's ready indicator appears,
   * or fall back to the fixed delay on timeout.
   *
   * Handles the Claude trust prompt: if detected, sends Enter to accept it
   * before continuing to poll for the actual input prompt.
   */
  private async waitForAgentReady(sessionName: string, agentType: string): Promise<void> {
    const pattern = AGENT_READY_PATTERNS[agentType];
    if (!pattern) {
      // No known ready pattern — fall back to fixed delay
      await this.sleep(CLAUDE_READY_DELAY_MS);
      return;
    }

    const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
    let trustPromptHandled = false;
    let codexResumeCwdPromptHandled = false;
    let sudoCodeBroadDirectoryPromptHandled = false;

    // Initial delay before first poll (agent needs time to start the process)
    await this.sleep(AGENT_READY_POLL_INTERVAL_MS);

    while (Date.now() < deadline) {
      try {
        const output = await this.backend.capturePane(sessionName, 50);

        // Handle trust prompt: send Enter to accept "Yes, I trust this folder"
        if (!trustPromptHandled && CLAUDE_TRUST_PROMPT_PATTERN.test(output)) {
          await this.backend.sendKeys(sessionName, '');
          trustPromptHandled = true;
          await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
          continue;
        }

        // Handle Codex resume cwd picker: accept the default selection and keep
        // polling until the actual idle input prompt appears.
        if (
          agentType === 'codex' &&
          !codexResumeCwdPromptHandled &&
          CODEX_RESUME_CWD_PROMPT_PATTERN.test(output)
        ) {
          await this.backend.sendKeys(sessionName, '');
          codexResumeCwdPromptHandled = true;
          await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
          continue;
        }

        if (
          agentType === 'sudocode' &&
          !sudoCodeBroadDirectoryPromptHandled &&
          SUDOCODE_BROAD_DIRECTORY_PROMPT_PATTERN.test(output)
        ) {
          await this.backend.sendKeys(sessionName, 'y');
          sudoCodeBroadDirectoryPromptHandled = true;
          await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
          continue;
        }

        if (pattern.test(output)) {
          // Brief settle delay — TUI input handler may not be fully interactive yet
          await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
          return;
        }
      } catch {
        // Session may not be ready yet — keep polling
      }
      await this.sleep(AGENT_READY_POLL_INTERVAL_MS);
    }

    // Timeout reached — proceed anyway (best-effort, matches old behavior)
  }

  /**
   * Capture native agent session metadata by sending a slash command
   * (/status or /stats) to the agent, waiting for output, and parsing the
   * terminal pane.
   *
   * Used for Codex, Gemini, and Sudo Code. Claude uses --session-id instead.
   * Returns null fields on failure (graceful fallback).
   */
  private async captureAgentSessionInfo(
    sessionName: string,
    agentType: string,
    workdir: string,
    launchStartedAt?: number,
  ): Promise<{ sessionId: string | null; agentSessionFile: string | null }> {
    const config = AGENT_SESSION_CAPTURE[agentType];
    if (!config) return { sessionId: null, agentSessionFile: null };

    try {
      // For REPL TUIs, wait for the prompt before sending status. Starting
      // with Codex 0.129, the trust prompt and first paint can take long enough
      // that fixed sleeps race the input handler and lose the status command.
      if (agentType === 'codex' || agentType === 'sudocode') {
        await this.waitForAgentReady(sessionName, agentType);
      } else {
        await this.sleep(config.readyDelayMs);
      }

      const existingOutput = await this.backend.capturePane(sessionName, 400);
      const existing = this.parseAgentSessionInfo(agentType, workdir, existingOutput);
      if (existing.sessionId) {
        return existing;
      }
      if (agentType === 'sudocode') {
        const latest = this.findLatestSudoCodeSessionInfo(workdir, launchStartedAt);
        if (latest.sessionId) {
          return latest;
        }
      }

      // Send status slash command (use sendMessage for reliable Enter delivery to TUIs)
      await this.backend.sendMessage(sessionName, config.statusCommand);

      // Poll pane output until session ID is found
      const maxAttempts = agentType === 'codex' ? 30 : 10;
      const pollInterval = config.captureDelayMs;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await this.sleep(pollInterval);
        const output = await this.backend.capturePane(sessionName, 400);
        const parsed = this.parseAgentSessionInfo(agentType, workdir, output);
        if (parsed.sessionId) {
          return parsed;
        }
        if (agentType === 'sudocode') {
          const latest = this.findLatestSudoCodeSessionInfo(workdir, launchStartedAt);
          if (latest.sessionId) {
            return latest;
          }
        }
      }

      console.warn(
        `[hydra] Could not parse session ID for ${agentType} in ${sessionName}`,
      );
      return { sessionId: null, agentSessionFile: null };
    } catch (error) {
      console.warn(`[hydra] Session ID capture failed for ${sessionName}:`, error);
      return { sessionId: null, agentSessionFile: null };
    }
  }

  private parseAgentSessionInfo(
    agentType: string,
    workdir: string,
    output: string,
  ): { sessionId: string | null; agentSessionFile: string | null } {
    const config = AGENT_SESSION_CAPTURE[agentType];
    if (!config) return { sessionId: null, agentSessionFile: null };

    const cleanOutput = this.stripAnsi(output);
    const sessionId = cleanOutput.match(config.sessionIdPattern)?.[1] ?? null;
    const capturedFile = config.sessionFilePattern
      ? cleanOutput.match(config.sessionFilePattern)?.[1]?.trim() ?? null
      : null;
    const resolvedFile = capturedFile ? this.resolveCapturedSessionFile(workdir, capturedFile) : null;
    const agentSessionFile = resolvedFile || resolveAgentSessionFile(agentType, workdir, sessionId);

    return { sessionId, agentSessionFile };
  }

  private findLatestSudoCodeSessionInfo(
    workdir: string,
    minMtimeMs?: number,
  ): { sessionId: string | null; agentSessionFile: string | null } {
    if (!workdir) return { sessionId: null, agentSessionFile: null };
    const root = path.join(workdir, '.scode', 'sessions');
    if (!fs.existsSync(root)) return { sessionId: null, agentSessionFile: null };

    let latestFile: string | null = null;
    let latestMtime = -1;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }

        try {
          const mtime = fs.statSync(entryPath).mtimeMs;
          if (minMtimeMs !== undefined && mtime < minMtimeMs - 1000) {
            continue;
          }
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestFile = entryPath;
          }
        } catch {
          // Best-effort scan; ignore files that disappear mid-walk.
        }
      }
    }

    if (!latestFile) return { sessionId: null, agentSessionFile: null };
    const basenameMatch = path.basename(latestFile).match(/^(session-\d+-\d+)\.jsonl$/);
    const sessionId = this.readSudoCodeSessionId(latestFile) || basenameMatch?.[1] || null;
    return { sessionId, agentSessionFile: latestFile };
  }

  private readSudoCodeSessionId(sessionFile: string): string | null {
    try {
      const raw = fs.readFileSync(sessionFile, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed?.type === 'session_meta' && typeof parsed.session_id === 'string') {
          return parsed.session_id;
        }
      }
    } catch {
      // Fall back to the filename.
    }
    return null;
  }

  private resolveCapturedSessionFile(workdir: string, sessionFile: string): string | null {
    const cleaned = sessionFile.trim();
    if (!cleaned) return null;
    const unquoted = cleaned.replace(/^['"]|['"]$/g, '');
    return path.normalize(path.isAbsolute(unquoted) ? unquoted : path.resolve(workdir, unquoted));
  }

  private stripAnsi(text: string): string {
    const escape = String.fromCharCode(27);
    return text.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
  }

  private async captureCleanPane(sessionName: string, lines: number): Promise<string> {
    return this.stripAnsi(await this.backend.capturePane(sessionName, lines));
  }

  private async updateAgentSessionInfo(
    sessionName: string,
    sessionId: string | null,
    agentSessionFile: string | null,
  ): Promise<void> {
    await this.updateSessionState((state) => {
      if (state.workers[sessionName]) {
        state.workers[sessionName].sessionId = sessionId;
        state.workers[sessionName].agentSessionFile = agentSessionFile;
        state.updatedAt = new Date().toISOString();
      } else if (state.copilots[sessionName]) {
        state.copilots[sessionName].sessionId = sessionId;
        state.copilots[sessionName].agentSessionFile = agentSessionFile;
        state.updatedAt = new Date().toISOString();
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private extractSlugFromSessionName(sessionName: string): string {
    const underscoreIdx = sessionName.indexOf('_');
    if (underscoreIdx >= 0) {
      return sessionName.substring(underscoreIdx + 1);
    }
    return sessionName;
  }

  private getDefaultAgentCommand(agentType: string): string {
    return getHydraGlobalAgentCommand(agentType) || DEFAULT_AGENT_COMMANDS[agentType] || agentType;
  }

  private async resolveAgentCommand(agentCommand: string): Promise<string> {
    const trimmed = agentCommand.trim();
    if (!trimmed) return agentCommand;

    const [binary, ...rest] = trimmed.split(/\s+/);
    if (!binary || binary.includes('/') || binary.includes('\\')) return trimmed;

    try {
      const resolved = await resolveCommandPath(binary);
      if (!resolved) return trimmed;
      return [shellQuote(resolved), ...rest].join(' ');
    } catch {
      return trimmed;
    }
  }

  private findSavedWorkerForBranch(
    repoRoot: string,
    branchName: string,
    preferredWorker?: WorkerInfo,
    options?: { includeArchive?: boolean },
  ): SavedWorkerMatch | undefined {
    if (preferredWorker && this.workerMatchesRepoBranch(preferredWorker, repoRoot, branchName)) {
      return { worker: this.normalizeSavedWorker(preferredWorker, repoRoot, branchName) };
    }

    const state = this.readSessionState();
    let latestMatch: SavedWorkerMatch | undefined;
    for (const [stateKey, worker] of Object.entries(state.workers)) {
      if (!this.workerMatchesRepoBranch(worker, repoRoot, branchName)) continue;
      const match = { worker: this.normalizeSavedWorker(worker, repoRoot, branchName), stateKey };
      if (!latestMatch || this.workerTimestamp(match.worker) >= this.workerTimestamp(latestMatch.worker)) {
        latestMatch = match;
      }
    }
    if (latestMatch) return latestMatch;

    if (!options?.includeArchive) return undefined;

    let latestArchived: ArchivedSessionInfo | undefined;
    for (const entry of this.readArchiveState().entries) {
      if (entry.type !== 'worker') continue;
      const worker = entry.data as WorkerInfo;
      if (!this.workerMatchesRepoBranch(worker, repoRoot, branchName)) continue;
      if (!latestArchived || Date.parse(entry.archivedAt || '') >= Date.parse(latestArchived.archivedAt || '')) {
        latestArchived = entry;
      }
    }

    if (!latestArchived) return undefined;
    return {
      worker: this.normalizeSavedWorker(latestArchived.data as WorkerInfo, repoRoot, branchName),
    };
  }

  private normalizeSavedWorker(worker: WorkerInfo, repoRoot: string, branchName: string): WorkerInfo {
    const slug = worker.slug || this.extractSlugFromSessionName(worker.sessionName) ||
      coreGit.branchNameToSlug(branchName, this.backend);
    const repoSessionNamespace = coreGit.getRepoSessionNamespace(repoRoot, this.backend);
    return {
      ...worker,
      repoRoot: worker.repoRoot || repoRoot,
      branch: worker.branch || branchName,
      slug,
      displayName: worker.displayName || slug,
      sessionName: worker.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug),
      tmuxSession: worker.tmuxSession || worker.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug),
      sessionId: worker.sessionId ?? null,
      copilotSessionName: worker.copilotSessionName ?? null,
    };
  }

  private workerMatchesRepoBranch(worker: WorkerInfo, repoRoot: string, branchName: string): boolean {
    if (!worker || worker.branch !== branchName) return false;
    return this.samePath(worker.repoRoot, repoRoot);
  }

  private samePath(left?: string, right?: string): boolean {
    const canonicalLeft = toCanonicalPath(left);
    const canonicalRight = toCanonicalPath(right);
    return !!canonicalLeft && !!canonicalRight && canonicalLeft === canonicalRight;
  }

  private workerTimestamp(worker: WorkerInfo): number {
    return Date.parse(worker.lastSeenAt || worker.createdAt || '') || 0;
  }

  private async findExistingWorktreePath(
    repoRoot: string,
    branchName: string,
    slug: string,
    savedWorkdir?: string,
    trustSavedWorkdir = false,
    requireKnownBranch = false,
  ): Promise<string | undefined> {
    const candidates = [
      savedWorkdir,
      path.join(coreGit.getManagedRepoWorktreesDir(repoRoot), slug),
      path.join(coreGit.getInRepoWorktreesDir(repoRoot), slug),
      path.join(coreGit.getLegacyTmuxWorktreesDir(repoRoot, this.backend), slug),
    ].filter((candidate): candidate is string => !!candidate);

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const canonical = toCanonicalPath(candidate) || path.resolve(candidate);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      if (!fs.existsSync(candidate)) continue;

      if (trustSavedWorkdir || await this.worktreePathMatchesBranch(repoRoot, candidate, branchName, requireKnownBranch)) {
        return candidate;
      }
    }

    return undefined;
  }

  private async worktreePathMatchesBranch(
    repoRoot: string,
    worktreePath: string,
    branchName: string,
    requireKnownBranch = false,
  ): Promise<boolean> {
    const worktreeBranch = await coreGit.getWorktreeBranch(repoRoot, worktreePath);
    if (!worktreeBranch) return !requireKnownBranch;
    return worktreeBranch === branchName;
  }

  private async resumeWorker(
    repoRoot: string,
    branchName: string,
    repoSessionNamespace: string,
    agentType: string,
    agentCommand: string,
    task?: string,
    savedWorkerMatch?: SavedWorkerMatch,
    copilotSessionName?: string,
    notifyCopilot = false,
    resumeSessionFile?: string | null,
  ): Promise<CreateWorkerResult> {
    const savedWorker = savedWorkerMatch?.worker;
    const slug = savedWorker?.slug || coreGit.branchNameToSlug(branchName, this.backend);
    const sessionName = savedWorker?.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug);
    const existingWorkerState = this.readSessionState().workers[sessionName] || savedWorker;
    const shouldNotifyCopilot = agentSupportsCompletionNotification(agentType) &&
      notifyCopilot &&
      !!copilotSessionName &&
      !!task &&
      existingWorkerState?.copilotSessionName === copilotSessionName;

    const isRunning = await this.backend.hasSession(sessionName);
    if (isRunning) {
      const sessionWorkdir = await this.backend.getSessionWorkdir(sessionName);
      if (!savedWorker) {
        const branchNeedsDisambiguation = branchName.trim() !== slug;
        if (
          (sessionWorkdir && !(await this.worktreePathMatchesBranch(repoRoot, sessionWorkdir, branchName, branchNeedsDisambiguation))) ||
          (!sessionWorkdir && branchNeedsDisambiguation)
        ) {
          throw new Error(`Branch "${branchName}" exists but saved worker identity was not found for "${sessionName}".`);
        }
      }

      if (task) {
        if (shouldNotifyCopilot) {
          this.armCompletionNotification(sessionName);
        }
        await this.backend.sendKeys(sessionName, task);
      }

      const workdir = sessionWorkdir || savedWorker?.workdir || '';
      const agent = await this.backend.getSessionAgent(sessionName) || agentType;
      const now = new Date().toISOString();

      const workerInfo = await this.updateSessionState((state) => {
        if (savedWorkerMatch?.stateKey && savedWorkerMatch.stateKey !== sessionName) {
          delete state.workers[savedWorkerMatch.stateKey];
        }

        const existingWorker = state.workers[sessionName] || savedWorker;
        const workerId = existingWorker?.workerId ?? state.nextWorkerId++;
        const nextWorker: WorkerInfo = {
          sessionName,
          displayName: existingWorker?.displayName || slug,
          workerId,
          repo: coreGit.getRepoName(repoRoot),
          repoRoot,
          branch: branchName,
          slug,
          status: 'running',
          attached: false,
          agent,
          workdir,
          tmuxSession: sessionName,
          createdAt: existingWorker?.createdAt ?? now,
          lastSeenAt: now,
          sessionId: existingWorker?.sessionId ?? null,
          agentSessionFile: resumeSessionFile ?? existingWorker?.agentSessionFile ?? null,
          copilotSessionName: existingWorker?.copilotSessionName ?? null,
        };

        state.workers[sessionName] = nextWorker;
        state.updatedAt = now;
        return nextWorker;
      });

      return {
        workerInfo,
        postCreatePromise: this.withPostCreateTimeout(Promise.resolve(), sessionName, 'worker startup'),
      };
    }

    // Worktree exists but tmux is dead — check new and legacy locations
    const worktreePath = await this.findExistingWorktreePath(
      repoRoot,
      branchName,
      slug,
      savedWorker?.workdir,
      false,
      !savedWorker && branchName.trim() !== slug,
    );
    if (worktreePath && fs.existsSync(worktreePath)) {
      await this.backend.createSession(sessionName, worktreePath);
      await this.backend.setSessionWorkdir(sessionName, worktreePath);
      await this.backend.setSessionRole(sessionName, 'worker');
      await this.backend.setSessionAgent(sessionName, agentType);

      const now = new Date().toISOString();
      const existingWorker = this.readSessionState().workers[sessionName] || savedWorker;
      const storedSessionId = existingWorker?.sessionId;
      const requestedResumeSessionFile = resumeSessionFile ?? existingWorker?.agentSessionFile ?? null;
      const resolvedResumeSessionFile = storedSessionId
        ? resolveAgentSessionFile(agentType, worktreePath, storedSessionId, requestedResumeSessionFile)
        : null;

      // Resume or fresh start
      const canResume = !!storedSessionId &&
        (agentType !== 'sudocode' || !!resolvedResumeSessionFile) &&
        !!buildAgentResumePlan(
          agentType,
          agentCommand,
          storedSessionId,
          worktreePath,
          resolvedResumeSessionFile,
        );

      let postCreatePromise: Promise<void>;
      let sessionId: string | null;

      if (canResume && storedSessionId) {
        // ── Resume flow: launch agent resume, no session ID capture needed ──
        // The agent already has its conversation context from the previous session.
        await this.launchAgentResume(
          sessionName,
          agentType,
          agentCommand,
          storedSessionId,
          worktreePath,
          resolvedResumeSessionFile,
        );
        sessionId = storedSessionId;
        // Skip Phase 1 (sessionId already known). Phase 2 only: send task if provided.
        postCreatePromise = (async () => {
          await this.waitForAgentReady(sessionName, agentType);
          await this.sendInitialPrompt(sessionName, task, shouldNotifyCopilot);
        })();
      } else {
        // ── Fresh start: Phase 1 (capture sessionId) → Phase 2 (send task) ──
        const preAssignedSessionId = agentType === 'claude' ? randomUUID() : null;
        const launchCmd = buildAgentLaunchCommand(agentType, agentCommand, undefined, preAssignedSessionId ?? undefined);
        const launchStartedAt = Date.now();
        await this.backend.sendKeys(sessionName, launchCmd);
        sessionId = preAssignedSessionId;
        postCreatePromise = (async () => {
          await this.waitForReadyAndCaptureSessionId(
            sessionName,
            agentType,
            preAssignedSessionId,
            worktreePath,
            launchStartedAt,
          );
          await this.sendInitialPrompt(sessionName, task, shouldNotifyCopilot);
        })();
      }

      const workerInfo = await this.updateSessionState((state) => {
        if (savedWorkerMatch?.stateKey && savedWorkerMatch.stateKey !== sessionName) {
          delete state.workers[savedWorkerMatch.stateKey];
        }

        const currentWorker = state.workers[sessionName] || savedWorker;
        const workerId = currentWorker?.workerId ?? state.nextWorkerId++;
        const nextWorker: WorkerInfo = {
          sessionName,
          displayName: currentWorker?.displayName || slug,
          workerId,
          repo: coreGit.getRepoName(repoRoot),
          repoRoot,
          branch: branchName,
          slug,
          status: 'running',
          attached: false,
          agent: agentType,
          workdir: worktreePath,
          tmuxSession: sessionName,
          createdAt: currentWorker?.createdAt ?? now,
          lastSeenAt: now,
          sessionId,
          agentSessionFile: canResume ? resolvedResumeSessionFile ?? requestedResumeSessionFile : null,
          copilotSessionName: currentWorker?.copilotSessionName ?? null,
        };

        state.workers[sessionName] = nextWorker;
        state.updatedAt = now;
        return nextWorker;
      });

      return {
        workerInfo,
        postCreatePromise: this.withPostCreateTimeout(postCreatePromise, sessionName, 'worker startup'),
      };
    }

    throw new Error(`Branch "${branchName}" exists but has no managed worktree. Delete the branch first or use a different name.`);
  }
}
