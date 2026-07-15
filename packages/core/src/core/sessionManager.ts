import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CopilotMode, MultiplexerBackendCore } from './types';
import * as coreGit from './git';
import { ensureHydraGlobalConfig, getHydraGlobalAgentCommand, getHydraGlobalDefaultAgent } from './hydraGlobalConfig';
import { buildAgentLaunchCommand, buildAgentResumePlan, CLAUDE_READY_DELAY_MS, AGENT_READY_TIMEOUT_MS, AGENT_READY_POLL_INTERVAL_MS, agentSupportsCompletionNotification, agentSupportsCopilotMode, getAgentDefaultCommand, getAgentDefinition, getAgentReadyPromptHandlers, getUnsupportedCopilotModeMessage, type AgentCommandOptions, type AgentPromptAction, type ShellTarget } from './agentConfig';
import { HYDRA_COPILOT_SESSION_ENV } from './env';
import { exec, resolveCommandPath } from './exec';
import { expandAndResolvePath, getHydraArchiveFile, getHydraHome, getHydraSessionsFile, getHydraTasksRoot, getTmuxCommand, resolveAgentSessionFile, toCanonicalPath } from './path';
import { shellQuote } from './shell';
import { buildWindowsCopilotSessionEnvPrefix, probePaneShellWithRetry, type WindowsPaneShell } from './copilotSessionEnv';
import { logger } from './logger';
import { hashText } from './logRedaction';
import { EventLog, type HydraEventRole } from './events';
import {
  WorkerRuntimeStateStore,
} from './workerRuntimeState';
import { ArchiveStore, type ArchiveStoreState } from './archiveStore';
import {
  buildAgentCompletionHookCommand,
  getAgentHookDiagnostic,
  installAgentHooks,
  removeAgentHooks,
} from './agentHookAdapter';
import {
  buildCompletionHookScript,
  getCompletionHookScriptPath,
  getLegacyCompletionHookScriptPath,
  removeLegacyCompletionHookScripts,
  removeLegacyCompletionPendingFiles,
  refreshCompletionHookScripts,
} from './completionHookScript';
import {
  createWorkerLifecycleEpoch,
  ensureWorkerIdentityMigrationBackup,
  getWorkerLifecycleEpoch,
  normalizeWorkerSessionAliases,
  workerMatchesSessionRoute,
} from './workerIdentity';

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const workers = Object.values(parsed.workers || {}) as WorkerInfo[];
      return workers.find(worker => workerMatchesSessionRoute(worker, sessionName))?.workerId;
    }
  } catch {
    // Best-effort
  }
  return undefined;
}

// ── Types ──

export type WorkerSource = 'repo' | 'directory';

export interface WorkerInfo {
  source?: WorkerSource;
  sessionName: string;
  /** Human-friendly name for display (branch slug or task name). */
  displayName: string;
  workerId: number;
  /** Stable for one worker process lifecycle and rotated on recreation/restore. */
  lifecycleEpoch?: string;
  /** Previous mutable session routes retained for compatibility lookup. */
  sessionAliases?: string[];
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
  slug: string;
  status: 'running' | 'stopped';
  attached: boolean;
  agent: string;
  workdir: string;
  /** True only for Hydra-owned task worker folders under ~/.hydra/tasks. */
  managedWorkdir?: boolean;
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
  copilotMode: CopilotMode;
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

export type ArchiveState = ArchiveStoreState<ArchivedSessionInfo>;

function isArchivedSessionInfo(value: unknown): value is ArchivedSessionInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ArchivedSessionInfo>;
  if (entry.type !== 'worker' && entry.type !== 'copilot') return false;
  if (typeof entry.sessionName !== 'string' || !entry.sessionName) return false;
  if (entry.agentSessionId !== null && typeof entry.agentSessionId !== 'string') return false;
  if (entry.agentSessionFile !== undefined && entry.agentSessionFile !== null && typeof entry.agentSessionFile !== 'string') return false;
  if (typeof entry.archivedAt !== 'string' || !Number.isFinite(Date.parse(entry.archivedAt))) return false;
  if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return false;
  return entry.data.sessionName === entry.sessionName;
}

interface SavedWorkerMatch {
  worker: WorkerInfo;
  stateKey?: string;
}

export interface CreateRepoWorkerOpts {
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
  /** Internal import control. Restore preserves workerId; cross-install imports allocate a local ID. */
  preserveWorkerId?: boolean;
  /**
   * Pre-create fetch behaviour:
   *   'best-effort' — default, swallow errors (used for ad-hoc abs-path repos)
   *   'required'    — error out if fetch fails (used for ~/.hydra/repos/-managed repos)
  */
  fetchMode?: 'best-effort' | 'required';
}

export type CreateWorkerOpts = CreateRepoWorkerOpts;

export interface CreateDirectoryWorkerOpts {
  workdir?: string;
  name?: string;
  managedWorkdir?: boolean;
  agentType?: string;
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
  /** Internal import control. Restore preserves workerId; cross-install imports allocate a local ID. */
  preserveWorkerId?: boolean;
}

export interface DeleteWorkerOpts {
  deleteFiles?: boolean;
}

interface PreparedWorkerLaunch {
  source: WorkerSource;
  sessionName: string;
  displayName: string;
  slug: string;
  workdir: string;
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
  managedWorkdir: boolean;
  agentType: string;
  agentCommand: string;
  task?: string;
  resumeSessionId?: string;
  resumeSessionFile?: string | null;
  copilotSessionName?: string;
  notifyCopilot: boolean;
  preservedWorkerInfo?: WorkerInfo;
  preservedStateKey?: string;
  preserveWorkerId: boolean;
}

interface WorkerNotificationInfo {
  sessionName: string;
  workerId: number;
  lifecycleEpoch: string;
  agentType: string;
}

interface ReservedWorkerIdentity {
  workerId: number;
  lifecycleEpoch: string;
  sessionAliases: string[];
}

export interface CreateCopilotOpts {
  workdir: string;
  agentType?: string;
  copilotMode?: CopilotMode;
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
  /** Resolves after the agent is ready. WorkerLifecycleService composes initial prompt delivery. */
  postCreatePromise: Promise<void>;
  /** Low-level delivery closure consumed by WorkerLifecycleService after completion intent is armed. */
  deliverInitialPrompt?: () => Promise<void>;
}

export interface CreateCopilotResult {
  copilotInfo: CopilotInfo;
  /** Resolves after the agent is ready and any deferred session ID capture has completed. */
  postCreatePromise: Promise<void>;
  /** True when the agent was resumed from a stored sessionId; false on fresh start. */
  resumed: boolean;
}

// Non-enumerable sentinel used by sync() to tell updateSessionState whether the
// mutator actually changed anything. Callers that don't set it keep the legacy
// unconditional-write semantics.
const SESSION_STATE_DIRTY_KEY = '__hydraDirty';
const SESSION_IDENTITY_MIGRATION_KEY = '__hydraIdentityMigration';
const TASK_WORKER_SESSION_NAMESPACE = 'task';

export function getWorkerSource(worker: WorkerInfo): WorkerSource {
  return worker.source === 'directory' ? 'directory' : 'repo';
}

export function isRepoWorker(worker: WorkerInfo): boolean {
  return getWorkerSource(worker) === 'repo';
}

export function isDirectoryWorker(worker: WorkerInfo): boolean {
  return getWorkerSource(worker) === 'directory';
}

function markSessionStateDirty(state: SessionState, dirty: boolean): void {
  Object.defineProperty(state, SESSION_STATE_DIRTY_KEY, {
    value: dirty,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function markSessionIdentityMigration(state: SessionState): void {
  Object.defineProperty(state, SESSION_IDENTITY_MIGRATION_KEY, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function consumeSessionIdentityMigration(state: SessionState): boolean {
  const marked = hasSessionIdentityMigration(state);
  delete (state as unknown as Record<string, unknown>)[SESSION_IDENTITY_MIGRATION_KEY];
  return marked;
}

function hasSessionIdentityMigration(state: SessionState): boolean {
  return (state as unknown as Record<string, unknown>)[SESSION_IDENTITY_MIGRATION_KEY] === true;
}

function consumeSessionStateDirty(state: SessionState): boolean | undefined {
  const record = state as unknown as Record<string, unknown>;
  if (!(SESSION_STATE_DIRTY_KEY in record)) return undefined;
  const value = record[SESSION_STATE_DIRTY_KEY] as boolean;
  delete record[SESSION_STATE_DIRTY_KEY];
  return value;
}

function normalizeCopilotMode(mode: CopilotMode | undefined): CopilotMode {
  return mode === 'plan' ? 'plan' : 'normal';
}

// ── SessionManager Class ──

export class SessionManager {
  constructor(
    private backend: MultiplexerBackendCore,
    private readonly eventLog: EventLog = new EventLog(),
    private readonly runtimeStateStore: WorkerRuntimeStateStore = new WorkerRuntimeStateStore(undefined, eventLog),
    private readonly archiveStore: ArchiveStore<ArchivedSessionInfo> = new ArchiveStore(
      getHydraArchiveFile(),
      isArchivedSessionInfo,
    ),
  ) {}

  // ── Sync: reconcile sessions.json <-> live multiplexer ──

  async sync(): Promise<SessionState> {
    const liveSessions = await this.backend.listSessions();
    const liveSessionMap = new Map(liveSessions.map(s => [s.name, s]));
    const orphanedWorkerSessions: string[] = [];
    const migratedWorkerIds = new Set<number>();
    const discoveredSessions = new Map<string, {
      role: 'worker' | 'copilot';
      agent: string;
      workdir: string;
    }>();

    await Promise.all(liveSessions.map(async (session) => {
      const role = session.role ?? await this.backend.getSessionRole(session.name);
      if (role !== 'worker' && role !== 'copilot') return;

      const [agent, workdir] = await Promise.all([
        session.agent !== undefined
          ? Promise.resolve(session.agent)
          : this.backend.getSessionAgent(session.name),
        session.workdir !== undefined
          ? Promise.resolve(session.workdir)
          : this.backend.getSessionWorkdir(session.name),
      ]);

      discoveredSessions.set(session.name, {
        role,
        agent: agent || 'unknown',
        workdir: workdir || '',
      });
    }));

    const state = await this.updateSessionState((state) => {
      const now = new Date().toISOString();
      let dirty = false;
      let identityDirty = false;
      const storedIdentityMigration = hasSessionIdentityMigration(state);
      const validWorkerIds = Object.values(state.workers)
        .map(worker => worker.workerId)
        .filter((workerId): workerId is number => Number.isSafeInteger(workerId) && workerId > 0);
      const normalizedNextWorkerId = Math.max(
        state.nextWorkerId,
        ...validWorkerIds.map(workerId => workerId + 1),
        1,
      );
      if (state.nextWorkerId !== normalizedNextWorkerId) {
        state.nextWorkerId = normalizedNextWorkerId;
        dirty = true;
        identityDirty = true;
      }
      const claimedWorkerIds = new Set<number>();
      const currentSessionRoutes = new Set(Object.values(state.workers).map(worker => worker.sessionName));
      const claimedAliases = new Set<string>();

      // Reconcile workers — only mark dirty on real status/attached/membership changes.
      // lastSeenAt is deliberately NOT bumped on every sidebar read; the real mutation
      // paths (createWorker, startWorker, persistCopilotSessionId, etc.) already refresh it.
      for (const [key, worker] of Object.entries(state.workers)) {
        const source = getWorkerSource(worker);
        // Backfill workerId for workers created before this feature
        let workerIdentityChanged = false;
        let workerIdChanged = false;
        if (!Number.isSafeInteger(worker.workerId)
          || worker.workerId <= 0
          || claimedWorkerIds.has(worker.workerId)) {
          worker.workerId = state.nextWorkerId++;
          workerIdChanged = true;
          dirty = true;
          identityDirty = true;
          workerIdentityChanged = true;
        }
        claimedWorkerIds.add(worker.workerId);
        const lifecycleEpoch = workerIdChanged
          ? createWorkerLifecycleEpoch()
          : getWorkerLifecycleEpoch(worker);
        if (worker.lifecycleEpoch !== lifecycleEpoch) {
          worker.lifecycleEpoch = lifecycleEpoch;
          dirty = true;
          identityDirty = true;
          workerIdentityChanged = true;
        }
        const sessionAliases = normalizeWorkerSessionAliases(worker)
          .filter(alias => !currentSessionRoutes.has(alias) && !claimedAliases.has(alias));
        for (const alias of sessionAliases) claimedAliases.add(alias);
        if (JSON.stringify(worker.sessionAliases ?? []) !== JSON.stringify(sessionAliases)) {
          worker.sessionAliases = sessionAliases;
          dirty = true;
          identityDirty = true;
          workerIdentityChanged = true;
        }
        if (workerIdentityChanged) migratedWorkerIds.add(worker.workerId);
        if (worker.source !== source) {
          worker.source = source;
          dirty = true;
        }
        if (worker.managedWorkdir == null) {
          worker.managedWorkdir = false;
          dirty = true;
        }
        const live = liveSessionMap.get(worker.sessionName);
        if (live) {
          if (worker.status !== 'running') { worker.status = 'running'; dirty = true; }
          if (worker.attached !== live.attached) { worker.attached = live.attached; dirty = true; }
        } else if (worker.workdir && fs.existsSync(worker.workdir)) {
          if (worker.status !== 'stopped') { worker.status = 'stopped'; dirty = true; }
          if (worker.attached !== false) { worker.attached = false; dirty = true; }
        } else if (source === 'directory') {
          if (worker.status !== 'stopped') { worker.status = 'stopped'; dirty = true; }
          if (worker.attached !== false) { worker.attached = false; dirty = true; }
        } else {
          // Orphan: tmux dead + no worktree
          orphanedWorkerSessions.push(worker.sessionName);
          delete state.workers[key];
          dirty = true;
        }
      }

      // Reconcile copilots
      for (const copilot of Object.values(state.copilots)) {
        const live = liveSessionMap.get(copilot.sessionName);
        if (live) {
          if (copilot.status !== 'running') { copilot.status = 'running'; dirty = true; }
          if (copilot.attached !== live.attached) { copilot.attached = live.attached; dirty = true; }
        } else {
          if (copilot.status !== 'stopped' || copilot.attached !== false) {
            copilot.status = 'stopped';
            copilot.attached = false;
            dirty = true;
          }
        }
      }

      // Discover live sessions with @hydra-role not yet in JSON
      const knownSessionNames = new Set([
        ...Object.values(state.workers).flatMap(worker => [
          worker.sessionName,
          ...normalizeWorkerSessionAliases(worker),
        ]),
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
          const source: WorkerSource = repoRoot ? 'repo' : 'directory';
          state.workers[session.name] = {
            source,
            sessionName: session.name,
            displayName: slug,
            workerId: state.nextWorkerId++,
            lifecycleEpoch: createWorkerLifecycleEpoch(),
            sessionAliases: [],
            repo: repoRoot ? path.basename(repoRoot) : null,
            repoRoot: repoRoot || null,
            branch: null,
            slug,
            status: 'running',
            attached: session.attached,
            agent: discovered.agent,
            workdir: discovered.workdir,
            managedWorkdir: false,
            tmuxSession: session.name,
            createdAt: now,
            lastSeenAt: now,
            sessionId: null,
            agentSessionFile: null,
            copilotSessionName: null,
          };
          dirty = true;
        } else {
          state.copilots[session.name] = {
            sessionName: session.name,
            displayName: session.name,
            status: 'running',
            attached: session.attached,
            agent: discovered.agent,
            copilotMode: 'normal',
            workdir: discovered.workdir,
            tmuxSession: session.name,
            createdAt: now,
            lastSeenAt: now,
            sessionId: null,
            agentSessionFile: null,
          };
          dirty = true;
        }
      }

      if (dirty) state.updatedAt = now;
      if (identityDirty) markSessionIdentityMigration(state);
      if (storedIdentityMigration) {
        for (const worker of Object.values(state.workers)) migratedWorkerIds.add(worker.workerId);
      }
      markSessionStateDirty(state, dirty);
      return state;
    });
    for (const sessionName of orphanedWorkerSessions) {
      this.clearWorkerRuntimeState(sessionName, 'sync-orphan');
    }
    for (const workerId of migratedWorkerIds) {
      const worker = Object.values(state.workers)
        .find(candidate => candidate.workerId === workerId);
      if (worker) this.ensureWorkerCompletionHook(worker);
    }
    return state;
  }

  async listWorkers(repoRoot?: string): Promise<WorkerInfo[]> {
    const state = await this.sync();
    const workers = Object.values(state.workers);
    if (!repoRoot) return workers;
    const canonical = path.resolve(repoRoot);
    return workers.filter(w => isRepoWorker(w) && w.repoRoot && path.resolve(w.repoRoot) === canonical);
  }

  /**
   * Read persisted worker metadata without reconciling it against live tmux or
   * worktree state. Mutation paths use this first so an orphan can still be
   * stopped, deleted, or reported accurately instead of disappearing in sync.
   */
  listPersistedWorkers(): WorkerInfo[] {
    return Object.values(this.readSessionState().workers);
  }

  async listCopilots(repoRoot?: string): Promise<CopilotInfo[]> {
    const state = await this.sync();
    const copilots = Object.values(state.copilots);
    if (!repoRoot) return copilots;
    const canonical = path.resolve(repoRoot);
    return copilots.filter(c => c.workdir && path.resolve(c.workdir).startsWith(canonical));
  }

  /**
   * Confirm that a post-create readiness wait ended on an actual agent prompt.
   * waitForAgentReady remains best-effort for legacy callers, so Desktop uses
   * this guard before pasting onboarding text into a pane that may have fallen
   * back to the user's shell.
   */
  async isAgentReady(sessionName: string, agentType: string): Promise<boolean> {
    const readyConfig = getAgentDefinition(agentType).ready;
    if (!readyConfig?.pattern) return true;

    try {
      const output = await this.backend.capturePane(sessionName, 50);
      const hasBlockingPrompt = getAgentReadyPromptHandlers(agentType)
        .some(handler => handler.blocksReadiness && handler.pattern.test(output));
      if (hasBlockingPrompt) return false;
      if (readyConfig.additionalBlockingPatterns?.some(pattern => pattern.test(output))) {
        return false;
      }
      return readyConfig.pattern.test(output);
    } catch {
      return false;
    }
  }

  async getWorker(sessionName: string): Promise<WorkerInfo | undefined> {
    const state = await this.sync();
    return Object.values(state.workers)
      .find(worker => workerMatchesSessionRoute(worker, sessionName));
  }

  getPersistedWorker(sessionName: string): WorkerInfo | undefined {
    return Object.values(this.readSessionState().workers)
      .find(worker => workerMatchesSessionRoute(worker, sessionName));
  }

  async ensurePersistedWorkerIdentities(): Promise<void> {
    await this.updateSessionState((state) => {
      const storedIdentityMigration = hasSessionIdentityMigration(state);
      const workers = Object.values(state.workers);
      const validWorkerIds = workers
        .map(worker => worker.workerId)
        .filter((workerId): workerId is number => Number.isSafeInteger(workerId) && workerId > 0);
      const normalizedNextWorkerId = Math.max(
        state.nextWorkerId,
        ...validWorkerIds.map(workerId => workerId + 1),
        1,
      );
      let changed = state.nextWorkerId !== normalizedNextWorkerId;
      state.nextWorkerId = normalizedNextWorkerId;
      const claimedWorkerIds = new Set<number>();
      const currentRoutes = new Set(workers.map(worker => worker.sessionName));
      const claimedAliases = new Set<string>();
      for (const worker of workers) {
        let workerIdChanged = false;
        if (!Number.isSafeInteger(worker.workerId)
          || worker.workerId <= 0
          || claimedWorkerIds.has(worker.workerId)) {
          worker.workerId = state.nextWorkerId++;
          workerIdChanged = true;
          changed = true;
        }
        claimedWorkerIds.add(worker.workerId);
        const lifecycleEpoch = workerIdChanged
          ? createWorkerLifecycleEpoch()
          : getWorkerLifecycleEpoch(worker);
        if (worker.lifecycleEpoch !== lifecycleEpoch) {
          worker.lifecycleEpoch = lifecycleEpoch;
          changed = true;
        }
        const aliases = normalizeWorkerSessionAliases(worker)
          .filter(alias => !currentRoutes.has(alias) && !claimedAliases.has(alias));
        for (const alias of aliases) claimedAliases.add(alias);
        if (JSON.stringify(worker.sessionAliases ?? []) !== JSON.stringify(aliases)) {
          worker.sessionAliases = aliases;
          changed = true;
        }
      }
      if (changed) {
        state.updatedAt = new Date().toISOString();
        markSessionIdentityMigration(state);
      } else if (storedIdentityMigration) {
        markSessionIdentityMigration(state);
      }
      markSessionStateDirty(state, changed || storedIdentityMigration);
    });
  }

  ensureWorkerCompletionHook(worker: WorkerInfo): boolean {
    if (!agentSupportsCompletionNotification(worker.agent)) return false;
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    if (!this.removeLegacyWorkerAgentHooks(worker)) return false;
    const installed = this.injectCompletionHook(worker.workdir, worker.agent, {
      sessionName: worker.sessionName,
      workerId: worker.workerId,
      lifecycleEpoch,
      agentType: worker.agent,
    }, true);
    if (installed) {
      refreshCompletionHookScripts([
        worker.sessionName,
        ...normalizeWorkerSessionAliases(worker),
      ], {
        workerId: worker.workerId,
        lifecycleEpoch,
        agentType: worker.agent,
      });
    }
    return installed;
  }

  private removeLegacyWorkerAgentHooks(worker: WorkerInfo): boolean {
    try {
      for (const sessionName of [worker.sessionName, ...normalizeWorkerSessionAliases(worker)]) {
        const legacyPath = getLegacyCompletionHookScriptPath(sessionName);
        if (!legacyPath || !fs.existsSync(legacyPath)) continue;
        removeAgentHooks({
          agentType: worker.agent,
          workdir: worker.workdir,
          sessionName,
          completionScriptPath: legacyPath,
        });
      }
      return true;
    } catch (error) {
      logger.warn('session.migrateAgentHooks', 'Worker legacy hook configuration was left unchanged', {
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        agent: worker.agent,
        error,
      });
      return false;
    }
  }

  async getCopilot(sessionName: string): Promise<CopilotInfo | undefined> {
    const state = await this.sync();
    return state.copilots[sessionName];
  }

  // ── Worker Lifecycle ──

  async createWorker(opts: CreateWorkerOpts): Promise<CreateWorkerResult> {
    return this.createRepoWorker(opts);
  }

  async createRepoWorker(opts: CreateRepoWorkerOpts): Promise<CreateWorkerResult> {
    ensureHydraGlobalConfig();

    const { repoRoot, branchName } = opts;
    let { task, taskFile } = opts;
    const agentType = opts.agentType || getHydraGlobalDefaultAgent().agent;
    let agentCommand = await this.resolveAgentCommand(opts.agentCommand || this.getDefaultAgentCommand(agentType));
    logger.info('session.createRepoWorker', 'Creating code worker', {
      repoRoot,
      branchName,
      agent: agentType,
      taskLength: task?.length ?? 0,
      taskHash: task ? hashText(task) : undefined,
      hasTaskFile: !!taskFile,
      fetchMode: opts.fetchMode,
    });

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
        opts.preserveWorkerId !== false,
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

    task = this.prepareTaskFile(worktreePath, task, taskFile, 'repo', 'implement').task;

    // Resolve @imports in instruction files
    this.resolveImports(path.join(worktreePath, 'CLAUDE.md'), repoRoot);
    this.resolveImports(path.join(worktreePath, 'AGENTS.md'), repoRoot);
    this.resolveImports(path.join(worktreePath, 'GEMINI.md'), repoRoot);

    const sessionName = preservedWorker?.worker.sessionName && preservedWorker.worker.slug === finalSlug
      ? preservedWorker.worker.sessionName
      : this.backend.buildSessionName(repoSessionNamespace, finalSlug);
    return this.launchPreparedWorker({
      source: 'repo',
      sessionName,
      displayName: finalSlug,
      slug: finalSlug,
      workdir: worktreePath,
      repo: coreGit.getRepoName(repoRoot),
      repoRoot,
      branch: branchName,
      managedWorkdir: false,
      agentType,
      agentCommand,
      task,
      resumeSessionId: opts.resumeSessionId,
      resumeSessionFile: opts.resumeSessionFile,
      copilotSessionName: opts.copilotSessionName,
      notifyCopilot: opts.notifyCopilot !== false,
      preservedWorkerInfo: preservedWorker?.worker,
      preservedStateKey: preservedWorker?.stateKey,
      preserveWorkerId: opts.preserveWorkerId !== false,
    });
  }

  async createDirectoryWorker(opts: CreateDirectoryWorkerOpts): Promise<CreateWorkerResult> {
    ensureHydraGlobalConfig();

    let workdir = opts.workdir ? expandAndResolvePath(opts.workdir) : '';
    const managedWorkdir = opts.managedWorkdir === true;
    const preservedWorker = opts.preservedWorkerInfo;
    const nameInput = opts.name || preservedWorker?.displayName || preservedWorker?.slug ||
      (workdir ? path.basename(workdir) : undefined);
    const slug = preservedWorker?.slug || this.normalizeTaskWorkerName(nameInput || '');

    if (managedWorkdir && !opts.name && !preservedWorker) {
      throw new Error('Task worker name is required for --temp.');
    }

    if (!workdir) {
      workdir = path.join(getHydraTasksRoot(), slug);
    }

    if (!preservedWorker) {
      if (managedWorkdir && fs.existsSync(workdir)) {
        throw new Error(`Task worker folder already exists: ${workdir}. Use a different --name or remove it first.`);
      }
      await this.assertDirectoryWorkerSessionAvailable(slug);
    }

    this.ensureDirectoryWorkdir(workdir);

    const task = this.prepareTaskFile(workdir, opts.task, opts.taskFile, 'directory', 'complete').task;
    const agentType = opts.agentType || getHydraGlobalDefaultAgent().agent;
    const agentCommand = await this.resolveAgentCommand(opts.agentCommand || this.getDefaultAgentCommand(agentType));
    const sessionName = preservedWorker?.sessionName || this.backend.buildSessionName(TASK_WORKER_SESSION_NAMESPACE, slug);
    logger.info('session.createDirectoryWorker', 'Creating task worker', {
      sessionName,
      workdir,
      slug,
      agent: agentType,
      managedWorkdir,
      taskLength: task?.length ?? 0,
      taskHash: task ? hashText(task) : undefined,
      hasTaskFile: !!opts.taskFile,
    });

    return this.launchPreparedWorker({
      source: 'directory',
      sessionName,
      displayName: preservedWorker?.displayName || slug,
      slug,
      workdir,
      repo: null,
      repoRoot: null,
      branch: null,
      managedWorkdir,
      agentType,
      agentCommand,
      task,
      resumeSessionId: opts.resumeSessionId,
      resumeSessionFile: opts.resumeSessionFile,
      copilotSessionName: opts.copilotSessionName,
      notifyCopilot: opts.notifyCopilot !== false,
      preservedWorkerInfo: preservedWorker,
      preserveWorkerId: opts.preserveWorkerId !== false,
    });
  }

  private async launchPreparedWorker(prepared: PreparedWorkerLaunch): Promise<CreateWorkerResult> {
    let agentCommand = prepared.agentCommand;
    const shouldInstallCompletionHook = agentSupportsCompletionNotification(prepared.agentType);
    const shouldInstallNeedsInputHooks = getAgentHookDiagnostic(prepared.agentType)
      .capabilities.needsInput === 'hook' && !!prepared.copilotSessionName;
    logger.info('session.launchWorker', 'Launching worker session', {
      source: prepared.source,
      sessionName: prepared.sessionName,
      workdir: prepared.workdir,
      repoRoot: prepared.repoRoot,
      branch: prepared.branch,
      agent: prepared.agentType,
      isResume: !!prepared.resumeSessionId,
      taskLength: prepared.task?.length ?? 0,
      taskHash: prepared.task ? hashText(prepared.task) : undefined,
      notifyCopilot: prepared.notifyCopilot && !!prepared.copilotSessionName,
    });

    const identity = await this.reserveWorkerIdentity(prepared);
    const { workerId, lifecycleEpoch } = identity;
    if (shouldInstallCompletionHook || shouldInstallNeedsInputHooks) {
      const now = new Date().toISOString();
      const hookWorker: WorkerInfo = {
        source: prepared.source,
        sessionName: prepared.sessionName,
        displayName: prepared.displayName,
        workerId,
        lifecycleEpoch,
        sessionAliases: identity.sessionAliases,
        repo: prepared.repo,
        repoRoot: prepared.repoRoot,
        branch: prepared.branch,
        slug: prepared.slug,
        status: 'stopped',
        attached: false,
        agent: prepared.agentType,
        workdir: prepared.workdir,
        managedWorkdir: prepared.managedWorkdir,
        tmuxSession: prepared.sessionName,
        createdAt: prepared.preservedWorkerInfo?.createdAt ?? now,
        lastSeenAt: now,
        sessionId: prepared.resumeSessionId ?? null,
        agentSessionFile: prepared.resumeSessionFile ?? null,
        copilotSessionName: prepared.copilotSessionName ?? null,
      };
      const hooksInstalled = shouldInstallCompletionHook
        ? this.ensureWorkerCompletionHook(hookWorker)
        : this.injectCompletionHook(prepared.workdir, prepared.agentType, {
          sessionName: prepared.sessionName,
          workerId,
          lifecycleEpoch,
          agentType: prepared.agentType,
        }, false);
      if (prepared.agentType === 'codex' && hooksInstalled) {
        const scriptPath = getCompletionHookScriptPath(workerId);
        const trustRoots = prepared.repoRoot ? [prepared.repoRoot, prepared.workdir] : [prepared.workdir];
        agentCommand = this.withCodexCompletionHookOverrides(agentCommand, trustRoots, scriptPath);
      }
    }

    await this.backend.createSession(prepared.sessionName, prepared.workdir);
    await this.backend.setSessionWorkdir(prepared.sessionName, prepared.workdir);
    await this.backend.setSessionRole(prepared.sessionName, 'worker');
    await this.backend.setSessionWorkerId?.(prepared.sessionName, workerId);
    await this.backend.setSessionAgent(prepared.sessionName, prepared.agentType);

    const isResume = !!prepared.resumeSessionId;
    let sessionId: string | null;
    let launchStartedAt: number | undefined;

    if (isResume) {
      sessionId = prepared.resumeSessionId!;
      await this.launchAgentResume(
        prepared.sessionName,
        prepared.agentType,
        agentCommand,
        sessionId,
        prepared.workdir,
        prepared.resumeSessionFile,
      );
    } else {
      sessionId = this.createPreassignedAgentSessionId(prepared.agentType);
      // Detect the pane shell once so launch-arg quoting matches the shell
      // that will execute the send-keyed command. See issue #225 §7 (codex
      // review round 1).
      const shellTarget = await this.detectShellTarget(prepared.sessionName);
      const launchCmd = buildAgentLaunchCommand(
        prepared.agentType,
        agentCommand,
        undefined,
        sessionId ?? undefined,
        { shellTarget },
      );
      launchStartedAt = Date.now();
      await this.backend.sendKeys(prepared.sessionName, launchCmd);
    }

    const workerInfo = await this.updateSessionState((state) => {
      const now = new Date().toISOString();
      if (prepared.preservedStateKey && prepared.preservedStateKey !== prepared.sessionName) {
        delete state.workers[prepared.preservedStateKey];
      }

      const existingWorker = state.workers[prepared.sessionName] || prepared.preservedWorkerInfo;
      const conflictingWorker = Object.values(state.workers)
        .find(candidate => candidate.workerId === workerId && candidate.sessionName !== prepared.sessionName);
      if (conflictingWorker) {
        throw new Error(`Worker #${workerId} is already assigned to "${conflictingWorker.sessionName}"`);
      }

      const nextWorker: WorkerInfo = {
        source: prepared.source,
        sessionName: prepared.sessionName,
        displayName: prepared.displayName,
        workerId,
        lifecycleEpoch,
        sessionAliases: identity.sessionAliases,
        repo: prepared.repo,
        repoRoot: prepared.repoRoot,
        branch: prepared.branch,
        slug: prepared.slug,
        status: 'running',
        attached: false,
        agent: prepared.agentType,
        workdir: prepared.workdir,
        managedWorkdir: prepared.managedWorkdir,
        tmuxSession: prepared.sessionName,
        createdAt: existingWorker?.createdAt ?? now,
        lastSeenAt: now,
        sessionId: sessionId ?? existingWorker?.sessionId ?? null,
        agentSessionFile: prepared.resumeSessionFile ?? existingWorker?.agentSessionFile ?? null,
        copilotSessionName: prepared.copilotSessionName ?? existingWorker?.copilotSessionName ?? null,
      };

      state.workers[prepared.sessionName] = nextWorker;
      state.updatedAt = now;
      return nextWorker;
    });
    await this.backend.setSessionWorkerId?.(prepared.sessionName, workerInfo.workerId);
    logger.info('session.launchWorker', 'Worker session persisted', {
      source: workerInfo.source,
      sessionName: workerInfo.sessionName,
      workdir: workerInfo.workdir,
      branch: workerInfo.branch,
      agent: workerInfo.agent,
      workerId: workerInfo.workerId,
      sessionId: workerInfo.sessionId,
    });
    if (!prepared.preservedWorkerInfo) {
      this.emitWorkerEvent('worker.created', workerInfo);
    }
    const postCreatePromise = this.withPostCreateTimeout((async () => {
      if (isResume) {
        await this.waitForAgentReady(prepared.sessionName, prepared.agentType);
      } else {
        await this.waitForReadyAndCaptureSessionId(
          prepared.sessionName,
          prepared.agentType,
          sessionId,
          prepared.workdir,
          launchStartedAt,
        );
      }
    })(), prepared.sessionName, 'worker startup');

    return {
      workerInfo,
      postCreatePromise,
      deliverInitialPrompt: prepared.task
        ? () => this.sendInitialPrompt(prepared.sessionName, prepared.task)
        : undefined,
    };
  }

  private async reserveWorkerIdentity(prepared: PreparedWorkerLaunch): Promise<ReservedWorkerIdentity> {
    return this.reserveWorkerIdentityValues(
      prepared.sessionName,
      prepared.preservedWorkerInfo,
      prepared.preserveWorkerId,
      prepared.preservedStateKey,
    );
  }

  private async reserveWorkerIdentityValues(
    sessionName: string,
    preservedWorker: WorkerInfo | undefined,
    preserveWorkerId: boolean,
    preservedStateKey?: string,
  ): Promise<ReservedWorkerIdentity> {
    return this.updateSessionState((state) => {
      const usedWorkerIds = Object.values(state.workers)
        .map(worker => worker.workerId)
        .filter((workerId): workerId is number => Number.isSafeInteger(workerId) && workerId > 0);
      state.nextWorkerId = Math.max(
        state.nextWorkerId,
        ...usedWorkerIds.map(workerId => workerId + 1),
        1,
      );
      const persistedWorker = state.workers[sessionName]
        ?? (preservedStateKey ? state.workers[preservedStateKey] : undefined);
      const existingWorker = persistedWorker ?? preservedWorker;
      const routeConflict = Object.values(state.workers)
        .find(candidate => workerMatchesSessionRoute(candidate, sessionName)
          && candidate !== persistedWorker);
      if (routeConflict) {
        throw new Error(`Session route "${sessionName}" is reserved by worker #${routeConflict.workerId}`);
      }
      let workerId: number;
      if (existingWorker && preserveWorkerId) {
        if (!Number.isSafeInteger(existingWorker.workerId) || existingWorker.workerId <= 0) {
          throw new Error('Preserved worker identity is missing a valid workerId');
        }
        const conflict = Object.values(state.workers)
          .find(candidate => candidate.workerId === existingWorker.workerId
            && candidate.sessionName !== existingWorker.sessionName);
        if (conflict) {
          throw new Error(`Worker #${existingWorker.workerId} is already assigned to "${conflict.sessionName}"`);
        }
        workerId = existingWorker.workerId;
        state.nextWorkerId = Math.max(state.nextWorkerId, workerId + 1);
      } else {
        workerId = state.nextWorkerId++;
      }
      const lifecycleEpoch = createWorkerLifecycleEpoch();
      const sessionAliases = existingWorker && preserveWorkerId
        ? normalizeWorkerSessionAliases(existingWorker)
        : [];
      if (existingWorker && preserveWorkerId) {
        if (preservedStateKey && preservedStateKey !== sessionName) {
          delete state.workers[preservedStateKey];
          sessionAliases.push(preservedStateKey);
        }
        state.workers[sessionName] = {
          ...existingWorker,
          sessionName,
          tmuxSession: sessionName,
          workerId,
          lifecycleEpoch,
          sessionAliases: [...new Set(sessionAliases)].filter(alias => alias !== sessionName),
          status: 'stopped',
          attached: false,
        };
      }
      state.updatedAt = new Date().toISOString();
      return {
        workerId,
        lifecycleEpoch,
        sessionAliases: [...new Set(sessionAliases)].filter(alias => alias !== sessionName),
      };
    });
  }

  async deleteWorker(sessionName: string, opts: DeleteWorkerOpts = {}): Promise<void> {
    const worker = this.readSessionState().workers[sessionName];
    const context = {
      type: 'worker',
      sessionName,
      found: !!worker,
      source: worker?.source,
      agent: worker?.agent,
      workdir: worker?.workdir,
      branch: worker?.branch,
      managedWorkdir: worker?.managedWorkdir,
      deleteFiles: opts.deleteFiles === true,
    };
    logger.info('session.delete', 'Deleting worker session', { ...context, phase: 'start' });

    try {
      const ownership = await this.assertHydraSessionOwnership(sessionName, 'worker');
      if (worker && isDirectoryWorker(worker) && opts.deleteFiles && !worker.managedWorkdir) {
        throw new Error(`Worker "${sessionName}" uses a user-provided directory. --delete-files is only supported for Hydra-managed task workers.`);
      }

      if (ownership.live) {
        await this.killSessionOrConfirmAbsent(sessionName);
      }
      logger.info('session.delete', 'Worker multiplexer session removed or absent', {
        ...context,
        phase: 'killSession',
      });

      const archivedWorker = worker ? this.prepareArchivedSessionData(worker) as WorkerInfo : undefined;
      let deletedFiles = false;
      let removedWorktree = false;
      let deletedBranch = false;

      if (worker && isDirectoryWorker(worker)) {
        if (opts.deleteFiles && worker.managedWorkdir && worker.workdir && fs.existsSync(worker.workdir)) {
          logger.info('session.delete', 'Deleting managed task worker files', {
            ...context,
            phase: 'deleteFiles',
          });
          try {
            fs.rmSync(worker.workdir, { recursive: true, force: true });
            deletedFiles = true;
            logger.info('session.delete', 'Deleted managed task worker files', {
              ...context,
              phase: 'deleteFiles',
            });
          } catch (error) {
            await this.updateSessionState((state) => {
              if (state.workers[sessionName]) {
                state.workers[sessionName].status = 'stopped';
                state.workers[sessionName].attached = false;
                state.updatedAt = new Date().toISOString();
              }
            });
            logger.error('session.delete', 'Failed to delete managed task worker files', {
              ...context,
              phase: 'deleteFiles',
              error,
            });
            throw error;
          }
        }
      } else if (worker && isRepoWorker(worker) && worker.workdir) {
        const workdirExists = fs.existsSync(worker.workdir);
        const canRunGitCleanup = workdirExists && await this.canRunRepoWorkerGitCleanup(worker);
        if (workdirExists && canRunGitCleanup && worker.repoRoot) {
          logger.info('session.delete', 'Removing worker worktree', {
            ...context,
            phase: 'removeWorktree',
            repoRoot: worker.repoRoot,
          });
          try {
            await coreGit.removeWorktree(worker.repoRoot, worker.workdir);
            removedWorktree = true;
            logger.info('session.delete', 'Removed worker worktree', {
              ...context,
              phase: 'removeWorktree',
              repoRoot: worker.repoRoot,
            });
          } catch (error) {
            await this.updateSessionState((state) => {
              if (state.workers[sessionName]) {
                state.workers[sessionName].status = 'stopped';
                state.workers[sessionName].attached = false;
                state.updatedAt = new Date().toISOString();
              }
            });
            logger.error('session.delete', 'Failed to remove worker worktree', {
              ...context,
              phase: 'removeWorktree',
              repoRoot: worker.repoRoot,
              error,
            });
            throw error;
          }

          if (worker.branch) {
            logger.info('session.delete', 'Deleting worker branch', {
              ...context,
              phase: 'deleteBranch',
              repoRoot: worker.repoRoot,
            });
            try {
              await exec(`git branch -D ${shellQuote(worker.branch)}`, {
                cwd: worker.repoRoot,
                logFailure: false,
              });
              deletedBranch = true;
              logger.info('session.delete', 'Deleted worker branch', {
                ...context,
                phase: 'deleteBranch',
                repoRoot: worker.repoRoot,
              });
            } catch {
              logger.debug('session.delete', 'Worker branch was not deleted', {
                ...context,
                phase: 'deleteBranch',
                repoRoot: worker.repoRoot,
              });
            }
          }
        } else if (workdirExists) {
          logger.warn('session.delete', 'Skipping worker worktree cleanup because repo root is unavailable', {
            ...context,
            phase: 'skipWorktreeCleanup',
            repoRoot: worker.repoRoot,
          });
        } else {
          logger.info('session.delete', 'Skipping worker worktree cleanup because workdir is already absent', {
            ...context,
            phase: 'skipWorktreeCleanup',
            repoRoot: worker.repoRoot,
          });
        }
      }

      // Archive only after destructive cleanup has succeeded, so failed deletes remain retryable.
      if (archivedWorker) {
        logger.info('session.delete', 'Archiving worker metadata', {
          ...context,
          phase: 'archive',
          agentSessionId: archivedWorker.sessionId,
        });
        this.archiveEntry('worker', archivedWorker.sessionName, archivedWorker.sessionId, archivedWorker);
      }

      await this.updateSessionState((state) => {
        if (state.workers[sessionName]) {
          delete state.workers[sessionName];
          state.updatedAt = new Date().toISOString();
        }
      });
      this.clearWorkerRuntimeState(sessionName, 'worker-deleted');

      const hookWorker = archivedWorker || worker;
      if (hookWorker) {
        try {
          const hookResult = removeAgentHooks({
            agentType: hookWorker.agent,
            workdir: hookWorker.workdir,
            sessionName,
            completionScriptPath: getCompletionHookScriptPath(hookWorker.workerId),
          });
          logger.info('session.delete', 'Removed worker agent hook configuration', {
            ...context,
            phase: 'removeAgentHooks',
            hookStatus: hookResult.status,
            hookConfigPaths: hookResult.configPaths,
          });
        } catch (error) {
          logger.warn('session.delete', 'Worker agent hook configuration was left unchanged', {
            ...context,
            phase: 'removeAgentHooks',
            error,
          });
        }
        const legacyRoutes = [
          hookWorker.sessionName,
          ...normalizeWorkerSessionAliases(hookWorker),
        ];
        removeLegacyCompletionHookScripts(legacyRoutes);
        removeLegacyCompletionPendingFiles(legacyRoutes);
      }

      logger.info('session.delete', 'Deleted worker session', {
        ...context,
        phase: 'complete',
        archived: !!archivedWorker,
        deletedFiles,
        removedWorktree,
        deletedBranch,
      });
      if (archivedWorker) {
        this.emitWorkerEvent('worker.deleted', archivedWorker, {
          archived: true,
          deletedFiles,
          removedWorktree,
          deletedBranch,
        });
      }
    } catch (error) {
      logger.error('session.delete', 'Failed to delete worker session', {
        ...context,
        phase: 'failed',
        error,
      });
      throw error;
    }
  }

  async stopWorker(sessionName: string): Promise<void> {
    const ownership = await this.assertHydraSessionOwnership(sessionName, 'worker');
    try {
      if (ownership.live) {
        await this.backend.killSession(sessionName);
      }
    } catch { /* Already dead */ }

    await this.updateSessionState((state) => {
      if (state.workers[sessionName]) {
        state.workers[sessionName].status = 'stopped';
        state.workers[sessionName].attached = false;
        state.updatedAt = new Date().toISOString();
      }
    });
    const stoppedWorker = this.readSessionState().workers[sessionName];
    if (stoppedWorker) {
      this.emitWorkerEvent('worker.stopped', stoppedWorker);
    }
  }

  async startWorker(sessionName: string, agentType?: string, agentCommand?: string): Promise<CreateWorkerResult> {
    const existingWorker = this.readSessionState().workers[sessionName];
    if (!existingWorker) {
      throw new Error(`Worker "${sessionName}" not found in sessions.json`);
    }

    if (!existingWorker.workdir || !fs.existsSync(existingWorker.workdir)) {
      throw new Error(`Workdir "${existingWorker.workdir}" does not exist`);
    }

    const agent = agentType || existingWorker.agent || getHydraGlobalDefaultAgent().agent;
    let command = await this.resolveAgentCommand(agentCommand || this.getDefaultAgentCommand(agent));
    logger.info('session.startWorker', 'Starting worker session', {
      sessionName,
      workdir: existingWorker.workdir,
      agent,
      source: getWorkerSource(existingWorker),
      hasStoredSessionId: !!existingWorker.sessionId,
    });

    const rotatedWorker = await this.updateSessionState((currentState) => {
      const currentWorker = currentState.workers[sessionName];
      if (!currentWorker) {
        throw new Error(`Worker "${sessionName}" not found in sessions.json`);
      }
      currentWorker.lifecycleEpoch = createWorkerLifecycleEpoch();
      currentWorker.sessionAliases = normalizeWorkerSessionAliases(currentWorker);
      currentWorker.agent = agent;
      currentState.updatedAt = new Date().toISOString();
      return { ...currentWorker };
    });
    const hooksInstalled = this.ensureWorkerCompletionHook(rotatedWorker);
    if (agent === 'codex' && hooksInstalled) {
      const trustRoots = rotatedWorker.repoRoot
        ? [rotatedWorker.repoRoot, rotatedWorker.workdir]
        : [rotatedWorker.workdir];
      command = this.withCodexCompletionHookOverrides(
        command,
        trustRoots,
        getCompletionHookScriptPath(rotatedWorker.workerId),
      );
    }

    await this.backend.createSession(sessionName, existingWorker.workdir);
    await this.backend.setSessionWorkdir(sessionName, existingWorker.workdir);
    await this.backend.setSessionRole(sessionName, 'worker');
    await this.backend.setSessionWorkerId?.(sessionName, existingWorker.workerId);
    await this.backend.setSessionAgent(sessionName, agent);

    // Resume from stored session ID if available; otherwise fresh start
    const storedSessionId = rotatedWorker.sessionId;
    const resolvedResumeSessionFile = storedSessionId
      ? resolveAgentSessionFile(agent, rotatedWorker.workdir, storedSessionId, rotatedWorker.agentSessionFile)
      : null;
    const canResume = this.canResumeAgentSession(
      agent,
      command,
      storedSessionId,
      rotatedWorker.workdir,
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
        rotatedWorker.workdir,
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
        currentWorker.agentSessionFile = resolvedResumeSessionFile ?? rotatedWorker.agentSessionFile ?? currentWorker.agentSessionFile ?? null;
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
      const preAssignedSessionId = this.createPreassignedAgentSessionId(agent);
      // Detect the pane shell once so launch-arg quoting matches the shell
      // that will execute the send-keyed command. See issue #225 §7 (codex
      // review round 1).
      const shellTarget = await this.detectShellTarget(sessionName);
      const launchCmd = buildAgentLaunchCommand(
        agent, command, undefined, preAssignedSessionId ?? undefined,
        { shellTarget },
      );
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
        rotatedWorker.workdir,
        launchStartedAt,
      );
    }

    await this.backend.setSessionWorkerId?.(sessionName, workerInfo.workerId);

    this.emitWorkerEvent('worker.started', workerInfo, { resumed: canResume });
    return {
      workerInfo,
      postCreatePromise: this.withPostCreateTimeout(postCreatePromise, sessionName, 'worker startup'),
    };
  }

  async startCopilot(sessionName: string): Promise<CreateCopilotResult> {
    const existingCopilot = this.readSessionState().copilots[sessionName];
    if (!existingCopilot) {
      throw new Error(`Copilot "${sessionName}" not found in sessions.json`);
    }

    const agent = existingCopilot.agent || getHydraGlobalDefaultAgent().agent;
    const copilotMode = normalizeCopilotMode(existingCopilot.copilotMode);
    const agentOptions: AgentCommandOptions = { copilotMode };
    const command = await this.resolveAgentCommand(this.getDefaultAgentCommand(agent));

    await this.backend.createSession(sessionName, existingCopilot.workdir);
    await this.backend.setSessionWorkdir(sessionName, existingCopilot.workdir);
    await this.backend.setSessionRole(sessionName, 'copilot');
    await this.backend.setSessionAgent(sessionName, agent);

    const storedSessionId = existingCopilot.sessionId;
    const resolvedResumeSessionFile = storedSessionId
      ? resolveAgentSessionFile(agent, existingCopilot.workdir, storedSessionId, existingCopilot.agentSessionFile)
      : null;
    const canResume = this.canResumeAgentSession(
      agent,
      command,
      storedSessionId,
      existingCopilot.workdir,
      resolvedResumeSessionFile,
    );

    let copilotInfo: CopilotInfo;
    let postCreatePromise: Promise<void>;

    if (canResume && storedSessionId) {
      await this.launchAgentResume(
        sessionName, agent, command, storedSessionId,
        existingCopilot.workdir, resolvedResumeSessionFile, agentOptions, sessionName,
      );
      copilotInfo = await this.updateSessionState((currentState) => {
        const current = currentState.copilots[sessionName];
        if (!current) throw new Error(`Copilot "${sessionName}" not found in sessions.json`);
        current.status = 'running';
        current.attached = false;
        current.agentSessionFile = resolvedResumeSessionFile ?? existingCopilot.agentSessionFile ?? current.agentSessionFile ?? null;
        current.lastSeenAt = new Date().toISOString();
        currentState.updatedAt = current.lastSeenAt;
        return { ...current };
      });
      postCreatePromise = this.waitForAgentReady(sessionName, agent);
    } else {
      const preAssignedSessionId = this.createPreassignedAgentSessionId(agent);
      // Detect the pane shell once and feed it to both the command builder
      // (so its embedded quoting matches the shell) and the env prefix.
      // See issue #225 §6 §7.
      const shellTarget = await this.detectShellTarget(sessionName);
      const launchCmd = await this.withCopilotSessionEnv(
        buildAgentLaunchCommand(agent, command, undefined, preAssignedSessionId ?? undefined, { ...agentOptions, shellTarget }),
        sessionName,
        shellTarget,
      );
      const launchStartedAt = Date.now();
      await this.backend.sendKeys(sessionName, launchCmd);
      copilotInfo = await this.updateSessionState((currentState) => {
        const current = currentState.copilots[sessionName];
        if (!current) throw new Error(`Copilot "${sessionName}" not found in sessions.json`);
        current.status = 'running';
        current.attached = false;
        current.sessionId = preAssignedSessionId;
        current.agentSessionFile = null;
        current.lastSeenAt = new Date().toISOString();
        currentState.updatedAt = current.lastSeenAt;
        return { ...current };
      });
      postCreatePromise = this.waitForReadyAndCaptureSessionId(
        sessionName, agent, preAssignedSessionId, existingCopilot.workdir, launchStartedAt,
      );
    }

    this.emitCopilotEvent('copilot.started', copilotInfo, { resumed: canResume });

    return {
      copilotInfo,
      postCreatePromise: this.withPostCreateTimeout(postCreatePromise, sessionName, 'copilot startup'),
      resumed: canResume,
    };
  }

  // ── Copilot Lifecycle ──

  async createCopilot(opts: CreateCopilotOpts): Promise<CreateCopilotResult> {
    ensureHydraGlobalConfig();

    const agentType = opts.agentType || getHydraGlobalDefaultAgent().agent;
    const copilotMode = normalizeCopilotMode(opts.copilotMode);
    if (!agentSupportsCopilotMode(agentType, copilotMode)) {
      throw new Error(getUnsupportedCopilotModeMessage(agentType, copilotMode));
    }

    const agentCommand = await this.resolveAgentCommand(opts.agentCommand || this.getDefaultAgentCommand(agentType));
    const defaultSessionName = copilotMode === 'plan' ? `hydra-plan-${agentType}` : `hydra-copilot-${agentType}`;
    const displayName = opts.name || opts.sessionName || defaultSessionName;
    const sessionName = opts.sessionName || this.backend.sanitizeSessionName(defaultSessionName);
    const agentOptions: AgentCommandOptions = { copilotMode };
    logger.info('session.createCopilot', 'Creating copilot session', {
      sessionName,
      displayName,
      workdir: opts.workdir,
      agent: agentType,
      copilotMode,
      isResume: !!opts.resumeSessionId,
    });

    const persistedState = this.readSessionState();
    const reservedWorkerRoute = Object.values(persistedState.workers)
      .some(worker => workerMatchesSessionRoute(worker, sessionName));
    const exists = await this.backend.hasSession(sessionName);
    if (exists || persistedState.copilots[sessionName] || reservedWorkerRoute) {
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
      await this.launchAgentResume(
        sessionName,
        agentType,
        agentCommand,
        sessionId,
        opts.workdir,
        opts.resumeSessionFile,
        agentOptions,
        sessionName,
      );
    } else {
      sessionId = this.createPreassignedAgentSessionId(agentType);
      // Detect the pane shell once and feed it to both the command builder
      // (so its embedded quoting matches the shell) and the env prefix.
      // See issue #225 §6 §7.
      const shellTarget = await this.detectShellTarget(sessionName);
      const launchCmd = await this.withCopilotSessionEnv(
        buildAgentLaunchCommand(agentType, agentCommand, undefined, sessionId ?? undefined, { ...agentOptions, shellTarget }),
        sessionName,
        shellTarget,
      );
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
      copilotMode,
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
        copilotMode,
      };

      state.copilots[sessionName] = nextCopilot;
      state.updatedAt = now;
      return nextCopilot;
    });
    logger.info('session.createCopilot', 'Copilot session persisted', {
      sessionName: persistedCopilotInfo.sessionName,
      workdir: persistedCopilotInfo.workdir,
      agent: persistedCopilotInfo.agent,
      copilotMode: persistedCopilotInfo.copilotMode,
      sessionId: persistedCopilotInfo.sessionId,
    });
    if (!opts.resumeSessionId) {
      this.emitCopilotEvent('copilot.created', persistedCopilotInfo);
    }

    // Match worker lifecycle semantics: wait for readiness and persist any deferred
    // session ID capture before the CLI treats creation as complete.
    postCreatePromise = this.withPostCreateTimeout(
      this.waitForReadyAndCaptureSessionId(sessionName, agentType, sessionId, opts.workdir, launchStartedAt),
      sessionName,
      'copilot startup',
    );

    return { copilotInfo: persistedCopilotInfo, postCreatePromise, resumed: isResume };
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

    if (isDirectoryWorker(worker)) {
      throw new Error(`Worker "${oldSessionName}" is a task worker. Branch rename is only available for code workers.`);
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
    const routeConflict = Object.values(state.workers)
      .some(candidate => candidate.workerId !== worker.workerId
        && workerMatchesSessionRoute(candidate, newSessionName));
    if (newSessionName !== oldSessionName && (routeConflict || state.copilots[newSessionName])) {
      throw new Error(`Session "${newSessionName}" already exists`);
    }
    if (await coreGit.localBranchExists(worker.repoRoot, newBranchName)) {
      throw new Error(`Branch "${newBranchName}" already exists`);
    }

    try {
      removeAgentHooks({
        agentType: worker.agent,
        workdir: worker.workdir,
        sessionName: worker.sessionName,
        completionScriptPath: getCompletionHookScriptPath(worker.workerId),
      });
    } catch (error) {
      throw new Error(`Worker hook route migration failed before rename: ${getErrorMessage(error)}`);
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

    const renamedWorker = await this.updateSessionState((currentState) => {
      const currentWorker = currentState.workers[oldSessionName];
      if (!currentWorker) {
        throw new Error(`Worker "${oldSessionName}" not found`);
      }

      const oldWorkdir = currentWorker.workdir;
      const oldAgentSessionFile = currentWorker.agentSessionFile ?? null;
      const sessionAliases = new Set(normalizeWorkerSessionAliases(currentWorker));
      if (oldSessionName !== newSessionName) sessionAliases.add(oldSessionName);
      sessionAliases.delete(newSessionName);
      const worktreeMoved = newSlug !== currentWorker.slug && fs.existsSync(newWorktreePath);
      delete currentState.workers[oldSessionName];
      currentWorker.sessionName = newSessionName;
      currentWorker.sessionAliases = [...sessionAliases];
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
    if (!this.ensureWorkerCompletionHook(renamedWorker)) {
      logger.warn('session.renameWorker', 'Renamed worker does not have a supported completion hook', {
        workerId: renamedWorker.workerId,
        sessionName: renamedWorker.sessionName,
        agent: renamedWorker.agent,
      });
    }
    return renamedWorker;
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
    const reservedWorkerRoute = Object.values(state.workers)
      .some(worker => workerMatchesSessionRoute(worker, newSessionName));
    if (state.copilots[newSessionName] || reservedWorkerRoute) {
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
    const copilot = this.readSessionState().copilots[sessionName];
    const context = {
      type: 'copilot',
      sessionName,
      found: !!copilot,
      agent: copilot?.agent,
      copilotMode: copilot?.copilotMode,
      workdir: copilot?.workdir,
    };
    logger.info('session.delete', 'Deleting copilot session', { ...context, phase: 'start' });

    try {
      const ownership = await this.assertHydraSessionOwnership(sessionName, 'copilot');
      try {
        if (ownership.live) {
          await this.backend.killSession(sessionName);
        }
      } catch { /* Already dead */ }
      logger.info('session.delete', 'Copilot multiplexer session removed or absent', {
        ...context,
        phase: 'killSession',
      });

      const archivedCopilot = copilot ? this.prepareArchivedSessionData(copilot) as CopilotInfo : undefined;

      // Archive before removing
      if (archivedCopilot) {
        logger.info('session.delete', 'Archiving copilot metadata', {
          ...context,
          phase: 'archive',
          agentSessionId: archivedCopilot.sessionId,
        });
        this.archiveEntry('copilot', archivedCopilot.sessionName, archivedCopilot.sessionId, archivedCopilot);
      }

      await this.updateSessionState((state) => {
        if (state.copilots[sessionName]) {
          delete state.copilots[sessionName];
          state.updatedAt = new Date().toISOString();
        }
      });
      logger.info('session.delete', 'Deleted copilot session', {
        ...context,
        phase: 'complete',
        archived: !!archivedCopilot,
      });
      if (archivedCopilot) {
        this.emitCopilotEvent('copilot.deleted', archivedCopilot, { archived: true });
      }
    } catch (error) {
      logger.error('session.delete', 'Failed to delete copilot session', {
        ...context,
        phase: 'failed',
        error,
      });
      throw error;
    }
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
    copilotMode?: CopilotMode,
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
        copilotMode: normalizeCopilotMode(copilotMode ?? existingCopilot?.copilotMode),
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
    const saved = Object.values(state.workers)
      .find(worker => workerMatchesSessionRoute(worker, sessionName))
      ?? state.copilots[sessionName];
    const workdir = saved?.workdir || await this.backend.getSessionWorkdir(sessionName) || '';
    const session = await this.captureAgentSessionInfo(sessionName, agentType, workdir);
    await this.updateAgentSessionInfo(sessionName, session.sessionId, session.agentSessionFile);
  }

  // ── Archive ──

  listArchived(): ArchivedSessionInfo[] {
    return this.archiveStore.list();
  }

  getArchivedAll(sessionName: string): ArchivedSessionInfo[] {
    return this.archiveStore.list().filter(entry => entry.sessionName === sessionName
      || (entry.type === 'worker'
        && workerMatchesSessionRoute(entry.data as WorkerInfo, sessionName)));
  }

  getArchived(sessionName: string): ArchivedSessionInfo | undefined {
    const all = this.getArchivedAll(sessionName);
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  listArchivedLatest(): ArchivedSessionInfo[] {
    const entries = this.archiveStore.list();
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
    if (isDirectoryWorker(worker)) {
      const workdir = worker.workdir;
      if (!workdir) {
        throw new Error(`Archived task worker "${sessionName}" is missing a workdir`);
      }
      if (!fs.existsSync(workdir) && !worker.managedWorkdir) {
        throw new Error(`Task worker workdir "${workdir}" does not exist`);
      }
      const result = await this.createDirectoryWorker({
        workdir,
        name: worker.displayName || worker.slug,
        managedWorkdir: worker.managedWorkdir === true,
        agentType: worker.agent,
        resumeSessionId: entry.agentSessionId || undefined,
        resumeSessionFile: entry.agentSessionFile || worker.agentSessionFile || undefined,
        preservedWorkerInfo: worker,
      });
      this.emitWorkerEvent('worker.restored', result.workerInfo, { archivedAt: entry.archivedAt });
      return result;
    }

    if (!worker.repoRoot || !worker.branch) {
      throw new Error(`Archived worker "${sessionName}" is missing repository metadata`);
    }
    const result = await this.createWorker({
      repoRoot: worker.repoRoot,
      branchName: worker.branch,
      agentType: worker.agent,
      resumeSessionId: entry.agentSessionId || undefined,
      resumeSessionFile: entry.agentSessionFile || worker.agentSessionFile || undefined,
      preservedWorkerInfo: worker,
    });
    this.emitWorkerEvent('worker.restored', result.workerInfo, { archivedAt: entry.archivedAt });
    return result;
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
    const result = await this.createCopilot({
      workdir: copilot.workdir,
      agentType: copilot.agent,
      copilotMode: copilot.copilotMode,
      name: copilot.displayName,
      sessionName: copilot.sessionName,
      resumeSessionId: entry.agentSessionId || undefined,
      resumeSessionFile: entry.agentSessionFile || copilot.agentSessionFile || undefined,
    });
    this.emitCopilotEvent('copilot.restored', result.copilotInfo, { archivedAt: entry.archivedAt });
    return result;
  }

  // ── Private helpers ──

  private emitLifecycleEvent(
    type: string,
    role: HydraEventRole,
    info: {
      sessionName: string;
      agent?: string | null;
      workdir?: string | null;
      payload?: Record<string, unknown>;
    },
  ): void {
    try {
      this.eventLog.append({
        type,
        source: 'session-manager',
        session: info.sessionName,
        role,
        agent: info.agent || undefined,
        workdir: info.workdir || undefined,
        payload: info.payload,
      });
    } catch (error) {
      logger.warn('session.event', 'Failed to append session lifecycle event', {
        type,
        sessionName: info.sessionName,
        role,
        error,
      });
    }
  }

  private emitWorkerEvent(type: string, worker: WorkerInfo, payload: Record<string, unknown> = {}): void {
    this.emitLifecycleEvent(type, 'worker', {
      sessionName: worker.sessionName,
      agent: worker.agent,
      workdir: worker.workdir,
      payload: {
        workerId: worker.workerId,
        lifecycleEpoch: getWorkerLifecycleEpoch(worker),
        source: getWorkerSource(worker),
        branch: isRepoWorker(worker) ? worker.branch : null,
        repo: isRepoWorker(worker) ? worker.repo : null,
        managedWorkdir: isDirectoryWorker(worker) ? worker.managedWorkdir === true : false,
        ...payload,
      },
    });
  }

  private clearWorkerRuntimeState(sessionName: string, reason: string): void {
    try {
      this.runtimeStateStore.clear(sessionName);
    } catch (error) {
      logger.warn('session.worker-runtime-state', 'Failed to clear worker runtime state', {
        sessionName,
        reason,
        error,
      });
    }
  }

  private async canRunRepoWorkerGitCleanup(worker: WorkerInfo): Promise<boolean> {
    if (!worker.repoRoot || !fs.existsSync(worker.repoRoot)) {
      return false;
    }
    return coreGit.isGitRepo(worker.repoRoot);
  }

  private emitCopilotEvent(type: string, copilot: CopilotInfo, payload: Record<string, unknown> = {}): void {
    this.emitLifecycleEvent(type, 'copilot', {
      sessionName: copilot.sessionName,
      agent: copilot.agent,
      workdir: copilot.workdir,
      payload: {
        copilotMode: copilot.copilotMode,
        ...payload,
      },
    });
  }

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

  private normalizeTaskWorkerName(name: string): string {
    const slug = this.backend.sanitizeSessionName(name.trim());
    if (!slug) {
      throw new Error('Task worker name is required.');
    }
    return slug;
  }

  private async assertDirectoryWorkerSessionAvailable(slug: string): Promise<void> {
    const sessionName = this.backend.buildSessionName(TASK_WORKER_SESSION_NAMESPACE, slug);
    const state = this.readSessionState();
    const liveExists = await this.backend.hasSession(sessionName);
    const reservedRoute = Object.values(state.workers)
      .some(worker => workerMatchesSessionRoute(worker, sessionName));
    if (reservedRoute || state.copilots[sessionName] || liveExists) {
      throw new Error(`Task worker "${slug}" already exists. Use a different --name or start/delete the existing worker.`);
    }
  }

  private ensureDirectoryWorkdir(workdir: string): void {
    if (fs.existsSync(workdir)) {
      if (!fs.statSync(workdir).isDirectory()) {
        throw new Error(`Task worker path is not a directory: ${workdir}`);
      }
      return;
    }
    fs.mkdirSync(workdir, { recursive: true });
  }

  private prepareTaskFile(
    workdir: string,
    task: string | undefined,
    taskFile: string | undefined,
    source: WorkerSource,
    defaultPromptVerb: 'implement' | 'complete',
  ): { task?: string; taskFilename?: string } {
    if (!taskFile) {
      return { task };
    }

    const absTaskFile = path.isAbsolute(taskFile) ? taskFile : path.resolve(taskFile);
    if (!fs.existsSync(absTaskFile)) {
      if (source === 'directory') {
        throw new Error(`Task file "${absTaskFile}" not found`);
      }
      return { task };
    }

    const taskFilename = path.basename(absTaskFile);
    const targetTaskFile = path.join(workdir, taskFilename);
    if (toCanonicalPath(absTaskFile) !== toCanonicalPath(targetTaskFile)) {
      fs.copyFileSync(absTaskFile, targetTaskFile);
    }

    if (!task) {
      return {
        task: `Read the task in \`${taskFilename}\` and ${defaultPromptVerb} it.`,
        taskFilename,
      };
    }

    return { task, taskFilename };
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

  async assertHydraSessionOwnership(
    sessionName: string,
    expectedKind?: 'worker' | 'copilot',
  ): Promise<{ kind: 'worker' | 'copilot'; live: boolean }> {
    const state = this.readSessionState();
    const worker = state.workers[sessionName];
    const copilot = state.copilots[sessionName];
    const kind = worker ? 'worker' : copilot ? 'copilot' : undefined;
    const session = worker ?? copilot;

    if (!kind || !session || (expectedKind && kind !== expectedKind)) {
      throw new Error(`Refusing to control unknown Hydra ${expectedKind ?? 'session'} "${sessionName}"`);
    }

    const live = await this.backend.hasSession(sessionName);
    if (!live) {
      return { kind, live: false };
    }

    const [role, tmuxWorkdir, tmuxWorkerId] = await Promise.all([
      this.backend.getSessionRole(sessionName),
      this.backend.getSessionWorkdir(sessionName),
      kind === 'worker' ? this.backend.getSessionWorkerId?.(sessionName) : Promise.resolve(undefined),
    ]);
    const expectedWorkdir = toCanonicalPath(session.workdir);
    const actualWorkdir = tmuxWorkdir ? toCanonicalPath(tmuxWorkdir) : undefined;

    if (role !== kind || !expectedWorkdir || actualWorkdir !== expectedWorkdir) {
      throw new Error(`Refusing to control foreign tmux session "${sessionName}": Hydra metadata does not match session state`);
    }
    if (worker && tmuxWorkerId !== undefined && tmuxWorkerId !== worker.workerId) {
      throw new Error(`Refusing to control foreign tmux session "${sessionName}": worker identity does not match session state`);
    }

    return { kind, live: true };
  }

  private archiveEntry(
    type: 'worker' | 'copilot',
    sessionName: string,
    agentSessionId: string | null,
    data: WorkerInfo | CopilotInfo,
  ): void {
    this.archiveStore.append({
      type,
      sessionName,
      agentSessionId,
      agentSessionFile: data.agentSessionFile ?? null,
      archivedAt: new Date().toISOString(),
      data: { ...data },
    });
    logger.info('session.archive', 'Archived session metadata', {
      type,
      sessionName,
      agent: data.agent,
      workdir: data.workdir,
      agentSessionId,
      agentSessionFile: data.agentSessionFile ?? null,
    });
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
          const hasWorkerId = Number.isSafeInteger(w.workerId) && w.workerId > 0;
          const needsIdentityMigration = !hasWorkerId || !w.lifecycleEpoch || !w.lifecycleEpoch.trim();
          const source = getWorkerSource(w);
          w.source ??= source;
          w.sessionId ??= null;
          w.agentSessionFile ??= null;
          w.displayName ??= w.slug || this.extractSlugFromSessionName(w.sessionName);
          w.managedWorkdir ??= false;
          if (hasWorkerId) w.lifecycleEpoch = getWorkerLifecycleEpoch(w);
          w.sessionAliases = normalizeWorkerSessionAliases(w);
          if (needsIdentityMigration) markSessionIdentityMigration(state);
          if (source === 'directory') {
            w.repo ??= null;
            w.repoRoot ??= null;
            w.branch ??= null;
          } else {
            w.repo ??= '';
            w.repoRoot ??= '';
            w.branch ??= '';
          }
        }
        for (const c of Object.values(state.copilots)) {
          c.sessionId ??= null;
          c.agentSessionFile ??= null;
          c.displayName ??= c.sessionName;
          c.copilotMode = normalizeCopilotMode(c.copilotMode);
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
      // Mutators that opt in (currently only sync()) signal whether anything
      // actually changed via markSessionStateDirty(). Other callers keep the
      // legacy unconditional-write behavior.
      const dirty = consumeSessionStateDirty(state);
      const identityMigration = consumeSessionIdentityMigration(state);
      if (dirty === undefined || dirty || identityMigration) {
        if (identityMigration) ensureWorkerIdentityMigrationBackup();
        this.writeSessionState(state);
      }
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
    logger.info('session.waitForReady', 'Waiting for agent readiness', {
      sessionName,
      agent: agentType,
      workdir,
      hasPreAssignedSessionId: !!preAssignedSessionId,
    });
    if (preAssignedSessionId) {
      // Claude (or resume): sessionId already known — just wait for TUI readiness
      await this.waitForAgentReady(sessionName, agentType);
    } else if (agentType === 'antigravity') {
      // Antigravity has no slash command that prints the conversation id, so
      // there is nothing to capture — but we still must wait for the TUI to
      // become ready (and handle the trust prompt) before the task is sent.
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
  ): Promise<void> {
    if (task) {
      logger.info('session.sendInitialPrompt', 'Sending initial worker prompt', {
        sessionName,
        promptLength: task.length,
        promptHash: hashText(task),
      });
      try {
        await this.backend.sendMessage(sessionName, task);
      } catch (error) {
        throw new Error(`Initial prompt delivery failed for "${sessionName}": ${getErrorMessage(error)}`);
      }
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
    info: WorkerNotificationInfo,
    includeCompletion = true,
  ): boolean {
    try {
      const scriptPath = getCompletionHookScriptPath(info.workerId);
      const result = installAgentHooks({
        agentType,
        workdir: worktreePath,
        sessionName: info.sessionName,
        workerId: info.workerId,
        lifecycleEpoch: info.lifecycleEpoch,
        completion: includeCompletion ? {
          path: scriptPath,
          content: buildCompletionHookScript({
            workerId: info.workerId,
            lifecycleEpoch: info.lifecycleEpoch,
            agentType: info.agentType,
          }),
          mode: 0o755,
        } : undefined,
      });
      logger.info('session.injectAgentHooks', 'Configured worker agent hooks', {
        sessionName: info.sessionName,
        agent: agentType,
        status: result.status,
        configPaths: result.configPaths,
        capabilities: result.diagnostic.capabilities,
      });
      return result.status !== 'unsupported';
    } catch (error) {
      // Hook signals are optional. Worker creation may proceed, but malformed
      // user configuration is never replaced with generated Hydra state.
      logger.warn('session.injectAgentHooks', 'Worker agent hook configuration was left unchanged', {
        sessionName: info.sessionName,
        agent: agentType,
        workdir: worktreePath,
        error,
      });
      return false;
    }
  }

  private withCodexCompletionHookOverrides(
    agentCommand: string,
    trustRootPaths: string[],
    scriptPath: string,
  ): string {
    const trustRoots = new Set(trustRootPaths);
    for (const trustPath of trustRootPaths) {
      try {
        trustRoots.add(fs.realpathSync(trustPath));
      } catch {
        // Fall back to the original path when realpath is unavailable.
      }
    }

    const projects = [...trustRoots]
      .map((trustRoot) => `${JSON.stringify(trustRoot)}={trust_level="trusted"}`)
      .join(',');
    const hookCommand = buildAgentCompletionHookCommand(scriptPath, 'codex');
    const hooksConfig = [
      'hooks={Stop=[{hooks=[{',
      'type="command",',
      `command=${JSON.stringify(hookCommand)}`,
      '}]}]}',
    ].join('');

    return [
      agentCommand.trim(),
      '-c',
      shellQuote('features.hooks=true'),
      '-c',
      shellQuote(`projects={${projects}}`),
      '-c',
      shellQuote(hooksConfig),
    ].join(' ');
  }

  // Prefix a command with an inline `HYDRA_COPILOT_SESSION=<value>` assignment
  // so the agent process the shell spawns next inherits the env var. On
  // Windows the syntax depends on the pane's shell — `$env:` works in
  // PowerShell, `set ""` works in cmd.exe — so we detect once via
  // psmux's default-shell option and emit the matching form. See issue #225 §6.
  // Callers that have already detected the shell (e.g. to pick a shellTarget
  // for buildAgentLaunchCommand, see issue #225 §7) can pass it explicitly to
  // avoid a redundant probe.
  private async withCopilotSessionEnv(
    command: string,
    sessionName?: string,
    shellTarget?: ShellTarget,
  ): Promise<string> {
    if (!sessionName) return command;
    if (process.platform !== 'win32') {
      return `${HYDRA_COPILOT_SESSION_ENV}=${shellQuote(sessionName)} ${command}`;
    }
    const winShell: WindowsPaneShell = shellTarget === 'cmd' || shellTarget === 'pwsh'
      ? shellTarget
      : await this.detectPaneShell(sessionName);
    return buildWindowsCopilotSessionEnvPrefix(winShell, sessionName, command);
  }

  // Resolve the shell that will execute commands send-keyed into the pane.
  // On non-Windows the shell is POSIX `sh`; on Windows we probe psmux's
  // default-shell. See issue #225 §6 §7.
  private async detectShellTarget(sessionName: string): Promise<ShellTarget> {
    if (process.platform !== 'win32') return 'posix';
    return this.detectPaneShell(sessionName);
  }

  // Probe the psmux session's default-shell. Retries a few times to ride out
  // transient probe failures right after createSession (socket race / server
  // restart), then falls back to PowerShell — the common Hydra-on-Windows
  // config — and logs a warning so users who actually picked cmd.exe can see
  // why their pane is getting PowerShell syntax. See issue #225 §6 (codex
  // review round 1).
  private async detectPaneShell(sessionName: string): Promise<WindowsPaneShell> {
    const tmuxCommand = getTmuxCommand();
    const command = `${tmuxCommand} show-options -t ${shellQuote(sessionName)} -gqv default-shell`;
    const result = await probePaneShellWithRetry(
      () => exec(command, { logFailure: false }),
    );
    if (result.usedFallback) {
      logger.warn(
        'session.detectPaneShell',
        'psmux default-shell probe failed after retries; defaulting to PowerShell. If your pane is cmd.exe, set psmux default-shell to pwsh.exe / powershell.exe or report the probe failure.',
        { sessionName, attempts: result.attempts },
      );
    }
    return result.shell;
  }

  private createPreassignedAgentSessionId(agentType: string): string | null {
    return getAgentDefinition(agentType).preassignSessionId ? randomUUID() : null;
  }

  private canResumeAgentSession(
    agentType: string,
    agentCommand: string,
    storedSessionId: string | null | undefined,
    workdir: string,
    resolvedResumeSessionFile?: string | null,
  ): boolean {
    if (!storedSessionId) {
      return false;
    }
    if (getAgentDefinition(agentType).resume?.requiresSessionFile && !resolvedResumeSessionFile) {
      return false;
    }
    return !!buildAgentResumePlan(
      agentType,
      agentCommand,
      storedSessionId,
      workdir,
      resolvedResumeSessionFile,
    );
  }

  private async launchAgentResume(
    sessionName: string,
    agentType: string,
    agentCommand: string,
    sessionId: string,
    workdir: string,
    agentSessionFile?: string | null,
    agentOptions?: AgentCommandOptions,
    copilotSessionName?: string,
  ): Promise<void> {
    // Detect the pane shell once and feed it to both the resume-plan builder
    // (so its embedded quoting matches the shell) and the env prefix.
    // See issue #225 §6 §7.
    const shellTarget = await this.detectShellTarget(sessionName);
    const resumePlan = buildAgentResumePlan(
      agentType, agentCommand, sessionId, workdir, agentSessionFile,
      { ...agentOptions, shellTarget },
    );
    if (!resumePlan) {
      throw new Error(`Agent "${agentType}" does not support session resume`);
    }

    await this.backend.sendKeys(
      sessionName,
      await this.withCopilotSessionEnv(resumePlan.command, copilotSessionName, shellTarget),
    );
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
    const waitMode = getAgentDefinition(agentType).resume?.waitForSlashCommandReady;
    if (waitMode === 'sudocodeSessionResumed' && slashCommand.trim().startsWith('/resume')) {
      await this.waitForSudoCodeResumeReady(sessionName, beforeCommandOutput);
      return;
    }

    await this.waitForAgentReady(sessionName, agentType);
  }

  private async waitForSudoCodeResumeReady(
    sessionName: string,
    beforeResumeOutput: string,
  ): Promise<void> {
    const pattern = getAgentDefinition('sudocode').ready?.pattern;
    if (!pattern) {
      await this.waitForAgentReady(sessionName, 'sudocode');
      return;
    }
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
   * Handles startup trust/review prompts before checking ready patterns. Codex
   * pickers also render `›`, so prompt handling must run before readiness
   * detection or Hydra will send setup slash commands into a modal.
   */
  private async waitForAgentReady(sessionName: string, agentType: string): Promise<void> {
    const readyConfig = getAgentDefinition(agentType).ready;
    const pattern = readyConfig?.pattern;
    if (!pattern) {
      // No known ready pattern — fall back to fixed delay
      await this.sleep(readyConfig?.fallbackDelayMs ?? CLAUDE_READY_DELAY_MS);
      return;
    }

    const deadline = Date.now() + readyConfig.timeoutMs;
    const pollIntervalMs = readyConfig.pollIntervalMs;
    const promptHandlers = getAgentReadyPromptHandlers(agentType);
    const handledPromptIds = new Set<string>();

    // Initial delay before first poll (agent needs time to start the process)
    await this.sleep(pollIntervalMs);

    poll:
    while (Date.now() < deadline) {
      try {
        const output = await this.backend.capturePane(sessionName, 50);

        for (const handler of promptHandlers) {
          if (handler.once && handledPromptIds.has(handler.id)) {
            continue;
          }
          if (!handler.pattern.test(output)) {
            continue;
          }
          await this.applyAgentPromptAction(sessionName, handler.handle(output));
          if (handler.once) {
            handledPromptIds.add(handler.id);
          }
          await this.sleep(pollIntervalMs);
          continue poll;
        }

        for (const handler of promptHandlers) {
          if (handler.blocksReadiness && handler.pattern.test(output)) {
            await this.sleep(pollIntervalMs);
            continue poll;
          }
        }

        if (readyConfig.additionalBlockingPatterns?.some(blockingPattern => blockingPattern.test(output))) {
          await this.sleep(pollIntervalMs);
          continue;
        }

        if (pattern.test(output)) {
          // Brief settle delay — TUI input handler may not be fully interactive yet
          await this.sleep(pollIntervalMs);
          return;
        }
      } catch {
        // Session may not be ready yet — keep polling
      }
      await this.sleep(pollIntervalMs);
    }

    // Timeout reached — proceed anyway (best-effort, matches old behavior)
  }

  private async applyAgentPromptAction(
    sessionName: string,
    action: AgentPromptAction | null,
  ): Promise<void> {
    if (!action || action.kind === 'wait') {
      return;
    }
    await this.backend.sendKeys(sessionName, action.keys);
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
    const config = getAgentDefinition(agentType).sessionCapture;
    if (!config) return { sessionId: null, agentSessionFile: null };
    const logCaptured = (result: { sessionId: string | null; agentSessionFile: string | null }, source: string) => {
      logger.info('session.captureAgentSessionInfo', 'Captured agent session info', {
        sessionName,
        agent: agentType,
        source,
        hasSessionId: !!result.sessionId,
        hasAgentSessionFile: !!result.agentSessionFile,
      });
    };

    try {
      logger.info('session.captureAgentSessionInfo', 'Capturing agent session info', {
        sessionName,
        agent: agentType,
        workdir,
      });
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
        logCaptured(existing, 'existing-output');
        return existing;
      }
      if (agentType === 'sudocode') {
        const latest = this.findLatestSudoCodeSessionInfo(workdir, launchStartedAt);
        if (latest.sessionId) {
          logCaptured(latest, 'sudocode-session-file');
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
          logCaptured(parsed, 'status-command');
          return parsed;
        }
        if (agentType === 'sudocode') {
          const latest = this.findLatestSudoCodeSessionInfo(workdir, launchStartedAt);
          if (latest.sessionId) {
            logCaptured(latest, 'sudocode-session-file');
            return latest;
          }
        }
      }

      console.warn(
        `[hydra] Could not parse session ID for ${agentType} in ${sessionName}`,
      );
      logger.warn('session.captureAgentSessionInfo', 'Could not parse agent session ID', {
        sessionName,
        agent: agentType,
      });
      return { sessionId: null, agentSessionFile: null };
    } catch (error) {
      console.warn(`[hydra] Session ID capture failed for ${sessionName}:`, error);
      logger.warn('session.captureAgentSessionInfo', 'Agent session capture failed', {
        sessionName,
        agent: agentType,
        error,
      });
      return { sessionId: null, agentSessionFile: null };
    }
  }

  private parseAgentSessionInfo(
    agentType: string,
    workdir: string,
    output: string,
  ): { sessionId: string | null; agentSessionFile: string | null } {
    const config = getAgentDefinition(agentType).sessionCapture;
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
    const eventInfo = await this.updateSessionState((state) => {
      const worker = Object.values(state.workers)
        .find(candidate => workerMatchesSessionRoute(candidate, sessionName));
      if (worker) {
        worker.sessionId = sessionId;
        worker.agentSessionFile = agentSessionFile;
        state.updatedAt = new Date().toISOString();
        return {
          role: 'worker' as const,
          sessionName: worker.sessionName,
          agent: worker.agent,
          workdir: worker.workdir,
        };
      } else if (state.copilots[sessionName]) {
        state.copilots[sessionName].sessionId = sessionId;
        state.copilots[sessionName].agentSessionFile = agentSessionFile;
        state.updatedAt = new Date().toISOString();
        return {
          role: 'copilot' as const,
          sessionName,
          agent: state.copilots[sessionName].agent,
          workdir: state.copilots[sessionName].workdir,
        };
      }
      return null;
    });
    if (sessionId && eventInfo) {
      this.emitLifecycleEvent('session.id.captured', eventInfo.role, {
        sessionName: eventInfo.sessionName,
        agent: eventInfo.agent,
        workdir: eventInfo.workdir,
        payload: {
          hasSessionId: true,
          hasAgentSessionFile: !!agentSessionFile,
        },
      });
    }
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
    return getHydraGlobalAgentCommand(agentType) || getAgentDefaultCommand(agentType) || agentType;
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
    for (const entry of this.archiveStore.list()) {
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
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      sessionAliases: normalizeWorkerSessionAliases(worker),
      source: 'repo',
      repoRoot: worker.repoRoot || repoRoot,
      repo: worker.repo || coreGit.getRepoName(repoRoot),
      branch: worker.branch || branchName,
      slug,
      displayName: worker.displayName || slug,
      managedWorkdir: false,
      sessionName: worker.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug),
      tmuxSession: worker.tmuxSession || worker.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug),
      sessionId: worker.sessionId ?? null,
      copilotSessionName: worker.copilotSessionName ?? null,
    };
  }

  private workerMatchesRepoBranch(worker: WorkerInfo, repoRoot: string, branchName: string): boolean {
    if (!worker || !isRepoWorker(worker) || worker.branch !== branchName) return false;
    return this.samePath(worker.repoRoot, repoRoot);
  }

  private samePath(left?: string | null, right?: string | null): boolean {
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
    preserveWorkerId = true,
    resumeSessionFile?: string | null,
  ): Promise<CreateWorkerResult> {
    const savedWorker = savedWorkerMatch?.worker;
    const slug = savedWorker?.slug || coreGit.branchNameToSlug(branchName, this.backend);
    const sessionName = savedWorker?.sessionName || this.backend.buildSessionName(repoSessionNamespace, slug);

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

      const workdir = sessionWorkdir || savedWorker?.workdir || '';
      const agent = await this.backend.getSessionAgent(sessionName) || agentType;
      const now = new Date().toISOString();
      const persistedWorker = this.readSessionState().workers[sessionName];
      const reservedIdentity = !persistedWorker || !preserveWorkerId
        ? await this.reserveWorkerIdentityValues(
          sessionName,
          persistedWorker ?? savedWorker,
          preserveWorkerId,
          savedWorkerMatch?.stateKey,
        )
        : undefined;

      const workerInfo = await this.updateSessionState((state) => {
        if (savedWorkerMatch?.stateKey && savedWorkerMatch.stateKey !== sessionName) {
          delete state.workers[savedWorkerMatch.stateKey];
        }

        const existingWorker = state.workers[sessionName] || savedWorker;
        const workerId = reservedIdentity?.workerId ?? existingWorker?.workerId ?? state.nextWorkerId++;
        const nextWorker: WorkerInfo = {
          source: 'repo',
          sessionName,
          displayName: existingWorker?.displayName || slug,
          workerId,
          lifecycleEpoch: reservedIdentity?.lifecycleEpoch
            ?? (existingWorker ? getWorkerLifecycleEpoch(existingWorker) : createWorkerLifecycleEpoch()),
          sessionAliases: reservedIdentity?.sessionAliases
            ?? (existingWorker ? normalizeWorkerSessionAliases(existingWorker) : []),
          repo: coreGit.getRepoName(repoRoot),
          repoRoot,
          branch: branchName,
          slug,
          status: 'running',
          attached: false,
          agent,
          workdir,
          managedWorkdir: false,
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
      await this.backend.setSessionWorkerId?.(sessionName, workerInfo.workerId);

      this.emitWorkerEvent('worker.started', workerInfo, {
        resumed: true,
        alreadyRunning: true,
      });
      return {
        workerInfo,
        postCreatePromise: this.withPostCreateTimeout(Promise.resolve(), sessionName, 'worker startup'),
        deliverInitialPrompt: task
          ? () => this.sendInitialPrompt(sessionName, task)
          : undefined,
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
      const existingWorker = this.readSessionState().workers[sessionName] || savedWorker;
      const identity = await this.reserveWorkerIdentityValues(
        sessionName,
        existingWorker,
        preserveWorkerId,
        savedWorkerMatch?.stateKey,
      );
      let resumeAgentCommand = agentCommand;
      const hookWorker: WorkerInfo = {
        ...(existingWorker ?? {
          source: 'repo' as const,
          sessionName,
          displayName: slug,
          repo: coreGit.getRepoName(repoRoot),
          repoRoot,
          branch: branchName,
          slug,
          status: 'stopped' as const,
          attached: false,
          agent: agentType,
          workdir: worktreePath,
          managedWorkdir: false,
          tmuxSession: sessionName,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          sessionId: null,
          copilotSessionName: null,
        }),
        workerId: identity.workerId,
        lifecycleEpoch: identity.lifecycleEpoch,
        sessionAliases: identity.sessionAliases,
        sessionName,
        agent: agentType,
        workdir: worktreePath,
      };
      const hooksInstalled = this.ensureWorkerCompletionHook(hookWorker);
      if (agentType === 'codex' && hooksInstalled) {
        resumeAgentCommand = this.withCodexCompletionHookOverrides(
          resumeAgentCommand,
          [repoRoot, worktreePath],
          getCompletionHookScriptPath(identity.workerId),
        );
      }
      await this.backend.createSession(sessionName, worktreePath);
      await this.backend.setSessionWorkdir(sessionName, worktreePath);
      await this.backend.setSessionRole(sessionName, 'worker');
      const workerId = identity.workerId;
      await this.backend.setSessionWorkerId?.(sessionName, workerId);
      await this.backend.setSessionAgent(sessionName, agentType);

      const now = new Date().toISOString();
      const storedSessionId = existingWorker?.sessionId;
      const requestedResumeSessionFile = resumeSessionFile ?? existingWorker?.agentSessionFile ?? null;
      const resolvedResumeSessionFile = storedSessionId
        ? resolveAgentSessionFile(agentType, worktreePath, storedSessionId, requestedResumeSessionFile)
        : null;

      // Resume or fresh start
      const canResume = this.canResumeAgentSession(
        agentType,
        resumeAgentCommand,
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
          resumeAgentCommand,
          storedSessionId,
          worktreePath,
          resolvedResumeSessionFile,
        );
        sessionId = storedSessionId;
        // Skip Phase 1 (sessionId already known). Phase 2 only: send task if provided.
        postCreatePromise = (async () => {
          await this.waitForAgentReady(sessionName, agentType);
        })();
      } else {
        // ── Fresh start: Phase 1 (capture sessionId) → Phase 2 (send task) ──
        const preAssignedSessionId = this.createPreassignedAgentSessionId(agentType);
        // Detect the pane shell once so launch-arg quoting matches the shell
        // that will execute the send-keyed command. See issue #225 §7 (codex
        // review round 1).
        const shellTarget = await this.detectShellTarget(sessionName);
        const launchCmd = buildAgentLaunchCommand(
          agentType, resumeAgentCommand, undefined, preAssignedSessionId ?? undefined,
          { shellTarget },
        );
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
        })();
      }

      const workerInfo = await this.updateSessionState((state) => {
        if (savedWorkerMatch?.stateKey && savedWorkerMatch.stateKey !== sessionName) {
          delete state.workers[savedWorkerMatch.stateKey];
        }

        const currentWorker = state.workers[sessionName] || savedWorker;
        const workerId = identity.workerId;
        const nextWorker: WorkerInfo = {
          source: 'repo',
          sessionName,
          displayName: currentWorker?.displayName || slug,
          workerId,
          lifecycleEpoch: identity.lifecycleEpoch,
          sessionAliases: identity.sessionAliases,
          repo: coreGit.getRepoName(repoRoot),
          repoRoot,
          branch: branchName,
          slug,
          status: 'running',
          attached: false,
          agent: agentType,
          workdir: worktreePath,
          managedWorkdir: false,
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
      await this.backend.setSessionWorkerId?.(sessionName, workerInfo.workerId);

      this.emitWorkerEvent('worker.started', workerInfo, {
        resumed: canResume,
        alreadyRunning: false,
      });
      return {
        workerInfo,
        postCreatePromise: this.withPostCreateTimeout(postCreatePromise, sessionName, 'worker startup'),
        deliverInitialPrompt: task
          ? () => this.sendInitialPrompt(sessionName, task)
          : undefined,
      };
    }

    throw new Error(`Branch "${branchName}" exists but has no managed worktree. Delete the branch first or use a different name.`);
  }
}
