import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventLog, type HydraEventSource } from './events';
import { getHydraHome } from './path';
import { logger } from './logger';
import { applyLegacyWorkerRuntimeState } from './workerRuntimeCoordinator';

export type WorkerRuntimeState = 'unknown' | 'running' | 'idle' | 'needs-input' | 'error';

export type WorkerRuntimeSignalOrigin =
  | 'session-manager'
  | 'hook'
  | 'notification'
  | 'codex-transcript'
  | 'manual';

export interface WorkerRuntimeSnapshot {
  sessionName: string;
  state: WorkerRuntimeState;
  updatedAt: string;
  origin: WorkerRuntimeSignalOrigin;
  reason?: string;
  notificationId?: string;
  workerId?: number;
  agent?: string | null;
  workdir?: string | null;
}

export interface SetWorkerRuntimeStateInput {
  sessionName: string;
  state: WorkerRuntimeState;
  origin: WorkerRuntimeSignalOrigin;
  reason?: string;
  notificationId?: string;
  workerId?: number;
  agent?: string | null;
  workdir?: string | null;
  updatedAt?: string;
  lifecycleEpoch?: string;
  runId?: string | null;
  revision?: number;
  signalId?: string;
  occurrenceId?: string;
  sourceSequence?: number;
}

export interface SetWorkerRuntimeStateResult {
  snapshot: WorkerRuntimeSnapshot;
  changed: boolean;
}

interface WorkerRuntimeStateFile {
  version: 1;
  workers: Record<string, WorkerRuntimeSnapshot>;
}

const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_SESSION_LENGTH = 200;
const MAX_REASON_LENGTH = 200;
const MAX_ORIGIN_LENGTH = 80;
const MAX_WORKDIR_LENGTH = 2000;

export function getHydraWorkerRuntimeStateFile(): string {
  return path.join(getHydraHome(), 'worker-runtime-state.json');
}

export class WorkerRuntimeStateStore {
  constructor(
    private readonly filePath: string = getHydraWorkerRuntimeStateFile(),
    private readonly eventLog: EventLog = new EventLog(),
  ) {}

  get(sessionName: string): WorkerRuntimeSnapshot | undefined {
    const normalized = normalizeSessionName(sessionName);
    if (!normalized) {
      return undefined;
    }
    const snapshot = this.readStore().workers[normalized];
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  list(): WorkerRuntimeSnapshot[] {
    return Object.values(this.readStore().workers)
      .sort((a, b) => a.sessionName.localeCompare(b.sessionName))
      .map(cloneSnapshot);
  }

  set(input: SetWorkerRuntimeStateInput, eventSource: HydraEventSource = 'extension'): SetWorkerRuntimeStateResult {
    return this.withLock(() => {
      const store = this.readStore();
      const snapshot = normalizeInput(input);
      const existing = store.workers[snapshot.sessionName];
      if (existing && snapshotsEqual(existing, snapshot)) {
        return { snapshot: cloneSnapshot(existing), changed: false };
      }

      store.workers[snapshot.sessionName] = snapshot;
      this.writeStore(store);
      this.emitRuntimeEvent(snapshot, existing, eventSource);
      return { snapshot: cloneSnapshot(snapshot), changed: true };
    });
  }

  project(input: SetWorkerRuntimeStateInput): SetWorkerRuntimeStateResult {
    return this.withLock(() => {
      const store = this.readStore();
      const snapshot = normalizeInput(input);
      const existing = store.workers[snapshot.sessionName];
      if (existing && snapshotsEqual(existing, snapshot)) {
        return { snapshot: cloneSnapshot(existing), changed: false };
      }
      store.workers[snapshot.sessionName] = snapshot;
      this.writeStore(store);
      return { snapshot: cloneSnapshot(snapshot), changed: true };
    });
  }

  clear(sessionName: string): boolean {
    const normalized = normalizeSessionName(sessionName);
    if (!normalized) {
      return false;
    }

    return this.withLock(() => {
      const store = this.readStore();
      if (!store.workers[normalized]) {
        return false;
      }
      delete store.workers[normalized];
      this.writeStore(store);
      return true;
    });
  }

  private readStore(): WorkerRuntimeStateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { version: STORE_VERSION, workers: {} };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.warn('worker-runtime-state.read', 'Ignoring invalid worker runtime state JSON', {
        filePath: this.filePath,
        error,
      });
      return { version: STORE_VERSION, workers: {} };
    }

    if (!parsed || typeof parsed !== 'object') {
      logger.warn('worker-runtime-state.read', 'Ignoring invalid worker runtime state shape', {
        filePath: this.filePath,
      });
      return { version: STORE_VERSION, workers: {} };
    }

    const store = parsed as Partial<WorkerRuntimeStateFile>;
    if (store.version !== STORE_VERSION || !store.workers || typeof store.workers !== 'object') {
      logger.warn('worker-runtime-state.read', 'Ignoring unsupported worker runtime state store', {
        filePath: this.filePath,
      });
      return { version: STORE_VERSION, workers: {} };
    }

    const workers: Record<string, WorkerRuntimeSnapshot> = {};
    for (const [sessionName, value] of Object.entries(store.workers)) {
      const snapshot = normalizeStoredSnapshot(sessionName, value);
      if (snapshot) {
        workers[snapshot.sessionName] = snapshot;
      }
    }
    return { version: STORE_VERSION, workers };
  }

  private writeStore(store: WorkerRuntimeStateFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, 'worker-runtime-state.lock');
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
          throw new Error(`Timed out waiting for worker runtime state lock at ${lockDir}`);
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

  private emitRuntimeEvent(
    snapshot: WorkerRuntimeSnapshot,
    previous: WorkerRuntimeSnapshot | undefined,
    source: HydraEventSource,
  ): void {
    try {
      this.eventLog.append({
        type: 'worker.runtime.changed',
        source,
        session: snapshot.sessionName,
        role: 'worker',
        agent: snapshot.agent,
        workdir: snapshot.workdir,
        payload: {
          state: snapshot.state,
          previousState: previous?.state,
          origin: snapshot.origin,
          reason: snapshot.reason,
          notificationId: snapshot.notificationId,
          workerId: snapshot.workerId,
          updatedAt: snapshot.updatedAt,
        },
      });
    } catch (error) {
      logger.warn('worker-runtime-state.event', 'Failed to append worker runtime event', {
        sessionName: snapshot.sessionName,
        state: snapshot.state,
        error,
      });
    }
  }
}

export function setWorkerRuntimeState(
  input: SetWorkerRuntimeStateInput,
  eventSource: HydraEventSource = 'extension',
  store = new WorkerRuntimeStateStore(),
): SetWorkerRuntimeStateResult {
  if (typeof input.workerId !== 'number') {
    return store.set(input, eventSource);
  }
  return applyLegacyWorkerRuntimeState(input, eventSource, store);
}

export function cloneWorkerRuntimeSnapshot(snapshot: WorkerRuntimeSnapshot): WorkerRuntimeSnapshot {
  return cloneSnapshot(snapshot);
}

function normalizeInput(input: SetWorkerRuntimeStateInput): WorkerRuntimeSnapshot {
  const sessionName = normalizeSessionName(input.sessionName);
  if (!sessionName) {
    throw new Error('Worker runtime state sessionName is required');
  }
  if (!isWorkerRuntimeState(input.state)) {
    throw new Error(`Invalid worker runtime state "${String(input.state)}"`);
  }

  const snapshot: WorkerRuntimeSnapshot = {
    sessionName,
    state: input.state,
    updatedAt: normalizeTimestamp(input.updatedAt),
    origin: normalizeOrigin(input.origin),
  };

  const reason = normalizeOptionalString(input.reason, MAX_REASON_LENGTH);
  if (reason) {
    snapshot.reason = reason;
  }
  const notificationId = normalizeOptionalString(input.notificationId, MAX_SESSION_LENGTH);
  if (notificationId) {
    snapshot.notificationId = notificationId;
  }
  if (typeof input.workerId === 'number' && Number.isFinite(input.workerId)) {
    snapshot.workerId = Math.trunc(input.workerId);
  }
  if (input.agent !== undefined) {
    snapshot.agent = normalizeNullableString(input.agent, MAX_SESSION_LENGTH);
  }
  if (input.workdir !== undefined) {
    snapshot.workdir = normalizeNullableString(input.workdir, MAX_WORKDIR_LENGTH);
  }

  return snapshot;
}

function normalizeStoredSnapshot(sessionName: string, value: unknown): WorkerRuntimeSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const item = value as Partial<WorkerRuntimeSnapshot>;
  const normalizedSession = normalizeSessionName(item.sessionName || sessionName);
  if (!normalizedSession || !isWorkerRuntimeState(item.state)) {
    return undefined;
  }

  const snapshot: WorkerRuntimeSnapshot = {
    sessionName: normalizedSession,
    state: item.state,
    updatedAt: typeof item.updatedAt === 'string' && item.updatedAt.trim()
      ? item.updatedAt
      : new Date(0).toISOString(),
    origin: normalizeOrigin(item.origin),
  };

  const reason = normalizeOptionalString(item.reason, MAX_REASON_LENGTH);
  if (reason) {
    snapshot.reason = reason;
  }
  const notificationId = normalizeOptionalString(item.notificationId, MAX_SESSION_LENGTH);
  if (notificationId) {
    snapshot.notificationId = notificationId;
  }
  if (typeof item.workerId === 'number' && Number.isFinite(item.workerId)) {
    snapshot.workerId = Math.trunc(item.workerId);
  }
  if (item.agent !== undefined) {
    snapshot.agent = normalizeNullableString(item.agent, MAX_SESSION_LENGTH);
  }
  if (item.workdir !== undefined) {
    snapshot.workdir = normalizeNullableString(item.workdir, MAX_WORKDIR_LENGTH);
  }

  return snapshot;
}

function snapshotsEqual(a: WorkerRuntimeSnapshot, b: WorkerRuntimeSnapshot): boolean {
  return a.sessionName === b.sessionName
    && a.state === b.state
    && a.origin === b.origin
    && a.reason === b.reason
    && a.notificationId === b.notificationId
    && a.workerId === b.workerId
    && a.agent === b.agent
    && a.workdir === b.workdir;
}

function cloneSnapshot(snapshot: WorkerRuntimeSnapshot): WorkerRuntimeSnapshot {
  return {
    ...snapshot,
  };
}

function isWorkerRuntimeState(value: unknown): value is WorkerRuntimeState {
  return value === 'unknown'
    || value === 'running'
    || value === 'idle'
    || value === 'needs-input'
    || value === 'error';
}

function normalizeOrigin(value: unknown): WorkerRuntimeSignalOrigin {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_ORIGIN_LENGTH)
    : '';
  switch (raw) {
    case 'session-manager':
    case 'hook':
    case 'notification':
    case 'codex-transcript':
    case 'manual':
      return raw;
    default:
      return 'manual';
  }
}

function normalizeSessionName(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value, MAX_SESSION_LENGTH);
}

function normalizeOptionalString(value: string | null | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim().slice(0, maxLength);
  return normalized || undefined;
}

function normalizeNullableString(value: string | null | undefined, maxLength: number): string | null {
  return normalizeOptionalString(value, maxLength) ?? null;
}

function normalizeTimestamp(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

function tryRemoveStaleLock(lockDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return;
  }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}
