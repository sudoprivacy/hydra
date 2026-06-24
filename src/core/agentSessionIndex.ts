import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  type ArchivedSessionInfo,
  type ArchiveState,
  type CopilotInfo,
  getWorkerSource,
  isDirectoryWorker,
  type SessionState,
  type WorkerInfo,
} from './sessionManager';
import {
  getHydraAgentSessionsFile,
  getHydraArchiveFile,
  getHydraSessionsFile,
  resolveAgentSessionFile,
  toCanonicalPath,
} from './path';
import {
  projectWorkerRuntimeState,
  WorkerRuntimeStateStore,
  type WorkerRuntimeProjection,
} from './workerRuntimeState';

export type AgentSessionIndexSource = 'active' | 'archive';
export type AgentSessionRole = 'worker' | 'copilot';
export type AgentSessionStatus = 'running' | 'stopped' | 'archived';

export type AgentSessionRuntimeStateProjection = WorkerRuntimeProjection;

export interface AgentSessionWorkerProjection {
  workerId: number | null;
  source: 'repo' | 'directory';
  type: 'code' | 'task';
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
  slug: string | null;
  managedWorkdir: boolean;
  copilotSessionName: string | null;
}

export interface AgentSessionCopilotProjection {
  mode: string;
}

export interface AgentSessionIndexEntry {
  schemaVersion: 1;
  recordId: string;
  source: AgentSessionIndexSource;
  role: AgentSessionRole;
  hydraSessionName: string;
  displayName: string | null;
  agent: string;
  agentSessionId: string | null;
  storedAgentSessionFile: string | null;
  storedAgentSessionFileExists: boolean;
  resolvedAgentSessionFile: string | null;
  agentSessionFileExists: boolean;
  workdir: string | null;
  status: AgentSessionStatus;
  createdAt: string | null;
  lastSeenAt: string | null;
  archivedAt: string | null;
  archiveOrdinal: number | null;
  worker?: AgentSessionWorkerProjection;
  copilot?: AgentSessionCopilotProjection;
  runtimeState?: AgentSessionRuntimeStateProjection;
}

export interface AgentSessionIndexState {
  schemaVersion: 1;
  generatedAt: string;
  sessions: AgentSessionIndexEntry[];
}

export interface RebuildAgentSessionIndexInput {
  state: SessionState;
  archiveEntries: ArchivedSessionInfo[];
}

export interface AgentSessionListFilters {
  role?: AgentSessionRole;
  source?: AgentSessionIndexSource;
  agent?: string;
  status?: AgentSessionStatus;
}

export interface AgentSessionInspectCandidate {
  recordId: string;
  source: AgentSessionIndexSource;
  role: AgentSessionRole;
  hydraSessionName: string;
  agent: string;
  agentSessionId: string | null;
  status: AgentSessionStatus;
  archivedAt: string | null;
  archiveOrdinal: number | null;
}

const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

export class AgentSessionInspectNotFoundError extends Error {
  constructor(readonly query: string) {
    super(`Agent session "${query}" not found`);
    this.name = 'AgentSessionInspectNotFoundError';
  }
}

export class AgentSessionInspectConflictError extends Error {
  constructor(
    readonly query: string,
    readonly candidates: AgentSessionInspectCandidate[],
  ) {
    super(`Agent session query "${query}" has multiple matches`);
    this.name = 'AgentSessionInspectConflictError';
  }
}

export class AgentSessionIndexStore {
  private readonly resolveCache = new Map<string, ResolvedAgentSessionFile>();

  constructor(
    private readonly filePath: string = getHydraAgentSessionsFile(),
    private readonly runtimeStateStore: WorkerRuntimeStateStore = new WorkerRuntimeStateStore(),
  ) {}

  get path(): string {
    return this.filePath;
  }

  snapshot(input: RebuildAgentSessionIndexInput): AgentSessionIndexState {
    this.resolveCache.clear();
    return this.build(input);
  }

  rebuild(input: RebuildAgentSessionIndexInput): AgentSessionIndexState {
    return this.withLock(() => {
      this.resolveCache.clear();
      const index = this.build(input);
      this.writeIndex(index);
      return index;
    });
  }

  private build(input: RebuildAgentSessionIndexInput): AgentSessionIndexState {
    const generatedAt = new Date().toISOString();
    const activeWorkers = Object.values(input.state.workers)
      .map(worker => this.workerEntry(worker))
      .sort(compareEntries);
    const activeCopilots = Object.values(input.state.copilots)
      .map(copilot => this.copilotEntry(copilot))
      .sort(compareEntries);
    const archived = input.archiveEntries
      .map((entry, index) => this.archiveEntry(entry, index))
      .sort(compareEntries);

    return {
      schemaVersion: STORE_VERSION,
      generatedAt,
      sessions: [...activeWorkers, ...activeCopilots, ...archived],
    };
  }

  private workerEntry(worker: WorkerInfo): AgentSessionIndexEntry {
    const resolved = this.resolveSessionFile(
      worker.agent,
      worker.workdir,
      worker.sessionId,
      worker.agentSessionFile ?? null,
    );
    return {
      schemaVersion: STORE_VERSION,
      recordId: `active:worker:${worker.sessionName}`,
      source: 'active',
      role: 'worker',
      hydraSessionName: worker.sessionName,
      displayName: worker.displayName || worker.slug || null,
      agent: worker.agent,
      agentSessionId: worker.sessionId ?? null,
      ...resolved,
      workdir: worker.workdir || null,
      status: worker.status,
      createdAt: worker.createdAt ?? null,
      lastSeenAt: worker.lastSeenAt ?? null,
      archivedAt: null,
      archiveOrdinal: null,
      worker: projectWorker(worker),
      runtimeState: projectWorkerRuntimeState(worker.status, this.runtimeStateStore.get(worker.sessionName)),
    };
  }

  private copilotEntry(copilot: CopilotInfo): AgentSessionIndexEntry {
    const resolved = this.resolveSessionFile(
      copilot.agent,
      copilot.workdir,
      copilot.sessionId,
      copilot.agentSessionFile ?? null,
    );
    return {
      schemaVersion: STORE_VERSION,
      recordId: `active:copilot:${copilot.sessionName}`,
      source: 'active',
      role: 'copilot',
      hydraSessionName: copilot.sessionName,
      displayName: copilot.displayName || copilot.sessionName || null,
      agent: copilot.agent,
      agentSessionId: copilot.sessionId ?? null,
      ...resolved,
      workdir: copilot.workdir || null,
      status: copilot.status,
      createdAt: copilot.createdAt ?? null,
      lastSeenAt: copilot.lastSeenAt ?? null,
      archivedAt: null,
      archiveOrdinal: null,
      copilot: {
        mode: normalizeCopilotMode(copilot.copilotMode),
      },
    };
  }

  private archiveEntry(
    entry: ArchivedSessionInfo,
    archiveOrdinal: number,
  ): AgentSessionIndexEntry {
    const data = entry.data;
    const agentSessionId = entry.agentSessionId ?? data.sessionId ?? null;
    const resolved = this.resolveSessionFile(
      data.agent,
      data.workdir,
      agentSessionId,
      entry.agentSessionFile ?? data.agentSessionFile ?? null,
    );
    const role = entry.type;
    const worker = role === 'worker' ? data as WorkerInfo : null;
    const copilot = role === 'copilot' ? data as CopilotInfo : null;
    return {
      schemaVersion: STORE_VERSION,
      recordId: `archive:${archiveOrdinal}:${entry.sessionName}`,
      source: 'archive',
      role,
      hydraSessionName: entry.sessionName,
      displayName: worker
        ? (worker.displayName || worker.slug || null)
        : (copilot?.displayName || entry.sessionName || null),
      agent: data.agent,
      agentSessionId,
      ...resolved,
      workdir: data.workdir || null,
      status: 'archived',
      createdAt: data.createdAt ?? null,
      lastSeenAt: data.lastSeenAt ?? null,
      archivedAt: entry.archivedAt,
      archiveOrdinal,
      ...(worker ? { worker: projectWorker(worker) } : {}),
      ...(copilot ? { copilot: { mode: normalizeCopilotMode(copilot.copilotMode) } } : {}),
    };
  }

  private resolveSessionFile(
    agent: string,
    workdir: string,
    sessionId: string | null,
    storedAgentSessionFile: string | null,
  ): ResolvedAgentSessionFile {
    const cacheKey = JSON.stringify([agent, workdir, sessionId, storedAgentSessionFile]);
    const cached = this.resolveCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const storedAgentSessionFileExists = storedAgentSessionFile ? safeExists(storedAgentSessionFile) : false;
    const resolvedAgentSessionFile = resolveAgentSessionFile(
      agent,
      workdir,
      sessionId,
      storedAgentSessionFile,
    );
    const resolved: ResolvedAgentSessionFile = {
      storedAgentSessionFile,
      storedAgentSessionFileExists,
      resolvedAgentSessionFile,
      agentSessionFileExists: resolvedAgentSessionFile ? safeExists(resolvedAgentSessionFile) : false,
    };
    this.resolveCache.set(cacheKey, resolved);
    return resolved;
  }

  private writeIndex(index: AgentSessionIndexState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempFile = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(tempFile, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
      fs.renameSync(tempFile, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Best-effort cleanup.
      }
      throw error;
    }
  }

  private withLock<T>(fn: () => T): T {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = `${this.filePath}.lock`;
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        tryRemoveStaleLock(lockDir);
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for agent session index lock at ${lockDir}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

export function selectAgentSessionListEntries(
  entries: AgentSessionIndexEntry[],
  includeAll: boolean,
): AgentSessionIndexEntry[] {
  if (includeAll) {
    return entries.slice().sort(compareEntries);
  }

  const activeSessionNames = new Set(
    entries
      .filter(entry => entry.source === 'active')
      .map(entry => entry.hydraSessionName),
  );
  const latestArchiveBySession = new Map<string, AgentSessionIndexEntry>();
  for (const entry of entries) {
    if (entry.source !== 'archive' || activeSessionNames.has(entry.hydraSessionName)) {
      continue;
    }
    const existing = latestArchiveBySession.get(entry.hydraSessionName);
    if (!existing || (entry.archiveOrdinal ?? -1) > (existing.archiveOrdinal ?? -1)) {
      latestArchiveBySession.set(entry.hydraSessionName, entry);
    }
  }

  return [
    ...entries.filter(entry => entry.source === 'active'),
    ...latestArchiveBySession.values(),
  ].sort(compareEntries);
}

export function filterAgentSessionEntries(
  entries: AgentSessionIndexEntry[],
  filters: AgentSessionListFilters,
): AgentSessionIndexEntry[] {
  return entries.filter(entry => {
    if (filters.role && entry.role !== filters.role) return false;
    if (filters.source && entry.source !== filters.source) return false;
    if (filters.agent && entry.agent !== filters.agent) return false;
    if (filters.status && entry.status !== filters.status) return false;
    return true;
  });
}

export function inspectAgentSessionIndex(
  index: AgentSessionIndexState,
  query: string,
): AgentSessionIndexEntry {
  const normalized = query.trim();
  if (!normalized) {
    throw new AgentSessionInspectNotFoundError(query);
  }

  const recordIdMatches = index.sessions.filter(entry => entry.recordId === normalized);
  if (recordIdMatches.length === 1) {
    return recordIdMatches[0];
  }
  if (recordIdMatches.length > 1) {
    throw new AgentSessionInspectConflictError(normalized, recordIdMatches.map(toCandidate));
  }

  const hydraSessionMatches = index.sessions.filter(entry => entry.hydraSessionName === normalized);
  if (hydraSessionMatches.length === 1) {
    return hydraSessionMatches[0];
  }
  if (hydraSessionMatches.length > 1) {
    throw new AgentSessionInspectConflictError(normalized, hydraSessionMatches.map(toCandidate));
  }

  const agentSessionIdMatches = index.sessions.filter(
    entry => entry.agentSessionId === normalized,
  );
  if (agentSessionIdMatches.length === 1) {
    return agentSessionIdMatches[0];
  }
  if (agentSessionIdMatches.length > 1) {
    throw new AgentSessionInspectConflictError(normalized, agentSessionIdMatches.map(toCandidate));
  }

  const sessionFileMatches = index.sessions.filter(entry => pathMatchesQuery(entry, normalized));
  if (sessionFileMatches.length === 1) {
    return sessionFileMatches[0];
  }
  if (sessionFileMatches.length > 1) {
    throw new AgentSessionInspectConflictError(normalized, sessionFileMatches.map(toCandidate));
  }

  throw new AgentSessionInspectNotFoundError(normalized);
}

export function readAgentSessionIndexSnapshot(
  store: AgentSessionIndexStore = new AgentSessionIndexStore(),
): AgentSessionIndexState {
  return store.snapshot({
    state: readSessionStateSnapshot(),
    archiveEntries: readArchiveStateSnapshot().entries,
  });
}

function projectWorker(worker: WorkerInfo): AgentSessionWorkerProjection {
  const source = getWorkerSource(worker);
  return {
    workerId: worker.workerId ?? null,
    source,
    type: isDirectoryWorker(worker) ? 'task' : 'code',
    repo: worker.repo || null,
    repoRoot: worker.repoRoot || null,
    branch: worker.branch || null,
    slug: worker.slug || null,
    managedWorkdir: worker.managedWorkdir === true,
    copilotSessionName: worker.copilotSessionName || null,
  };
}

function compareEntries(a: AgentSessionIndexEntry, b: AgentSessionIndexEntry): number {
  const sourceCompare = sourceRank(a.source) - sourceRank(b.source);
  if (sourceCompare !== 0) return sourceCompare;
  const roleCompare = roleRank(a.role) - roleRank(b.role);
  if (roleCompare !== 0) return roleCompare;
  const nameCompare = a.hydraSessionName.localeCompare(b.hydraSessionName);
  if (nameCompare !== 0) return nameCompare;
  return (a.archiveOrdinal ?? -1) - (b.archiveOrdinal ?? -1);
}

function sourceRank(source: AgentSessionIndexSource): number {
  return source === 'active' ? 0 : 1;
}

function roleRank(role: AgentSessionRole): number {
  return role === 'worker' ? 0 : 1;
}

function normalizeCopilotMode(mode: string | undefined): string {
  return mode === 'plan' ? 'plan' : 'normal';
}

function readArchiveStateSnapshot(): ArchiveState {
  const archiveFile = getHydraArchiveFile();
  try {
    if (fs.existsSync(archiveFile)) {
      const parsed = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
      return { entries: parsed.entries || [] };
    }
  } catch {
    // Corrupted files are ignored for a read-only diagnostic snapshot.
  }
  return { entries: [] };
}

function readSessionStateSnapshot(): SessionState {
  const sessionsFile = getHydraSessionsFile();
  try {
    if (fs.existsSync(sessionsFile)) {
      const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
      const state: SessionState = {
        copilots: parsed.copilots || {},
        workers: parsed.workers || {},
        nextWorkerId: parsed.nextWorkerId || 1,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };

      for (const worker of Object.values(state.workers)) {
        const source = getWorkerSource(worker);
        worker.source ??= source;
        worker.sessionId ??= null;
        worker.agentSessionFile ??= null;
        worker.displayName ??= worker.slug || extractSlugFromSessionName(worker.sessionName);
        worker.managedWorkdir ??= false;
        if (source === 'directory') {
          worker.repo ??= null;
          worker.repoRoot ??= null;
          worker.branch ??= null;
        } else {
          worker.repo ??= '';
          worker.repoRoot ??= '';
          worker.branch ??= '';
        }
      }
      for (const copilot of Object.values(state.copilots)) {
        copilot.sessionId ??= null;
        copilot.agentSessionFile ??= null;
        copilot.displayName ??= copilot.sessionName;
        copilot.copilotMode = normalizeCopilotMode(copilot.copilotMode) as CopilotInfo['copilotMode'];
      }

      return state;
    }
  } catch {
    // Corrupted files are ignored for a read-only diagnostic snapshot.
  }
  return { copilots: {}, workers: {}, nextWorkerId: 1, updatedAt: new Date().toISOString() };
}

function extractSlugFromSessionName(sessionName: string): string {
  const underscoreIdx = sessionName.indexOf('_');
  if (underscoreIdx >= 0) {
    return sessionName.substring(underscoreIdx + 1);
  }
  return sessionName;
}

function pathMatchesQuery(entry: AgentSessionIndexEntry, query: string): boolean {
  const files = [
    entry.storedAgentSessionFile,
    entry.resolvedAgentSessionFile,
  ].filter((file): file is string => Boolean(file));

  if (files.some(file => file === query)) {
    return true;
  }

  const canonicalQuery = toCanonicalPath(query);
  if (!canonicalQuery) {
    return false;
  }

  return files.some(file => toCanonicalPath(file) === canonicalQuery);
}

function toCandidate(entry: AgentSessionIndexEntry): AgentSessionInspectCandidate {
  return {
    recordId: entry.recordId,
    source: entry.source,
    role: entry.role,
    hydraSessionName: entry.hydraSessionName,
    agent: entry.agent,
    agentSessionId: entry.agentSessionId,
    status: entry.status,
    archivedAt: entry.archivedAt,
    archiveOrdinal: entry.archiveOrdinal,
  };
}

function safeExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

interface ResolvedAgentSessionFile {
  storedAgentSessionFile: string | null;
  storedAgentSessionFileExists: boolean;
  resolvedAgentSessionFile: string | null;
  agentSessionFileExists: boolean;
}

function tryRemoveStaleLock(lockDir: string): void {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
