import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';
import type { WorkerRuntimeState } from './workerRuntimeState';

export type WorkerRuntimeSignalOriginV2 = 'lifecycle' | 'hook' | 'codex-transcript' | 'manual';

export interface WorkerRuntimeSnapshotV2 {
  version: 2;
  workerId: number;
  sessionName: string;
  lifecycleEpoch: string;
  runId: string | null;
  revision: number;
  state: WorkerRuntimeState;
  signalId: string;
  occurrenceId?: string;
  sourceSequence?: number;
  origin: WorkerRuntimeSignalOriginV2;
  reason: string;
  observedAt: string;
  agent?: string | null;
  workdir?: string | null;
}

export type WorkerRuntimeSignalV2 = Omit<WorkerRuntimeSnapshotV2, 'version'>;

export interface WorkerRuntimeStateFileV2 {
  version: 2;
  workers: Record<string, WorkerRuntimeSnapshotV2>;
  processedSignalIds: Record<string, Record<string, string[]>>;
  pendingCompatibilityClears: Record<string, string[]>;
}

const STORE_VERSION = 2;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_SESSION_LENGTH = 200;
const MAX_ID_LENGTH = 500;
const MAX_REASON_LENGTH = 200;
const MAX_AGENT_LENGTH = 200;
const MAX_WORKDIR_LENGTH = 2000;

export function getHydraWorkerRuntimeStateFileV2(): string {
  return path.join(getHydraHome(), 'worker-runtime-state-v2.json');
}

export class WorkerRuntimeStateStoreV2 {
  constructor(private readonly filePath: string = getHydraWorkerRuntimeStateFileV2()) {}

  get(workerId: number): WorkerRuntimeSnapshotV2 | undefined {
    validateWorkerId(workerId);
    const snapshot = this.readStore().workers[String(workerId)];
    return snapshot ? { ...snapshot } : undefined;
  }

  list(): WorkerRuntimeSnapshotV2[] {
    return Object.values(this.readStore().workers)
      .sort((a, b) => a.workerId - b.workerId)
      .map(snapshot => ({ ...snapshot }));
  }

  update<T>(mutator: (store: WorkerRuntimeStateFileV2) => T): T {
    return this.withLock(() => {
      const store = this.readStore();
      const result = mutator(store);
      this.writeStore(store);
      return result;
    });
  }

  clear(workerId: number): boolean {
    validateWorkerId(workerId);
    return this.update(store => {
      const key = String(workerId);
      const removed = !!store.workers[key]
        || !!store.processedSignalIds[key]
        || !!store.pendingCompatibilityClears[key];
      delete store.workers[key];
      delete store.processedSignalIds[key];
      delete store.pendingCompatibilityClears[key];
      return removed;
    });
  }

  static hasProcessedSignal(
    store: WorkerRuntimeStateFileV2,
    workerId: number,
    lifecycleEpoch: string,
    signalId: string,
  ): boolean {
    return (store.processedSignalIds[String(workerId)]?.[lifecycleEpoch] ?? []).includes(signalId);
  }

  static rememberSignal(
    store: WorkerRuntimeStateFileV2,
    workerId: number,
    lifecycleEpoch: string,
    signalId: string,
  ): void {
    const key = String(workerId);
    const byEpoch = store.processedSignalIds[key] ?? {};
    byEpoch[lifecycleEpoch] = [...(byEpoch[lifecycleEpoch] ?? []), signalId];
    store.processedSignalIds[key] = byEpoch;
  }

  getPendingCompatibilityClears(workerId: number): string[] {
    validateWorkerId(workerId);
    return [...(this.readStore().pendingCompatibilityClears[String(workerId)] ?? [])];
  }

  acknowledgeCompatibilityClears(workerId: number, sessionNames: readonly string[]): void {
    validateWorkerId(workerId);
    if (sessionNames.length === 0) return;
    const acknowledged = new Set(sessionNames);
    this.update(store => {
      const key = String(workerId);
      const remaining = (store.pendingCompatibilityClears[key] ?? [])
        .filter(sessionName => !acknowledged.has(sessionName));
      if (remaining.length > 0) {
        store.pendingCompatibilityClears[key] = remaining;
      } else {
        delete store.pendingCompatibilityClears[key];
      }
    });
  }

  private readStore(): WorkerRuntimeStateFileV2 {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyStore();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Worker runtime v2 store at ${this.filePath} is not valid JSON`, { cause: error });
    }
    return parseStore(parsed, this.filePath);
  }

  private writeStore(store: WorkerRuntimeStateFileV2): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const lockDir = path.join(directory, 'worker-runtime-state-v2.lock');
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        removeStaleLock(lockDir);
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for worker runtime v2 lock at ${lockDir}`);
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

export function validateWorkerRuntimeSignalV2(signal: WorkerRuntimeSignalV2): void {
  validateWorkerId(signal.workerId);
  validateRequiredString(signal.sessionName, 'sessionName', MAX_SESSION_LENGTH);
  validateRequiredString(signal.lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
  validateNullableId(signal.runId, 'runId');
  validateNonNegativeSafeInteger(signal.revision, 'revision');
  validateState(signal.state);
  validateRequiredString(signal.signalId, 'signalId', MAX_ID_LENGTH);
  validateOptionalString(signal.occurrenceId, 'occurrenceId', MAX_ID_LENGTH);
  if (signal.sourceSequence !== undefined) {
    validateNonNegativeSafeInteger(signal.sourceSequence, 'sourceSequence');
  }
  validateOrigin(signal.origin);
  validateRequiredString(signal.reason, 'reason', MAX_REASON_LENGTH);
  validateTimestamp(signal.observedAt, 'observedAt');
  validateOptionalNullableString(signal.agent, 'agent', MAX_AGENT_LENGTH);
  validateOptionalNullableString(signal.workdir, 'workdir', MAX_WORKDIR_LENGTH);
}

function parseStore(value: unknown, filePath: string): WorkerRuntimeStateFileV2 {
  if (!isRecord(value)
    || value.version !== STORE_VERSION
    || !isRecord(value.workers)
    || !isRecord(value.processedSignalIds)
    || !isRecord(value.pendingCompatibilityClears)) {
    throw new Error(`Worker runtime v2 store at ${filePath} has unsupported version or shape`);
  }

  const workers: Record<string, WorkerRuntimeSnapshotV2> = {};
  for (const [key, snapshotValue] of Object.entries(value.workers)) {
    if (!isRecord(snapshotValue) || snapshotValue.version !== STORE_VERSION) {
      throw new Error(`Worker runtime v2 store at ${filePath} contains invalid snapshot for worker ${key}`);
    }
    const signal = { ...snapshotValue } as unknown as WorkerRuntimeSignalV2;
    delete (signal as Partial<WorkerRuntimeSnapshotV2>).version;
    validateWorkerRuntimeSignalV2(signal);
    if (String(signal.workerId) !== key) {
      throw new Error(`Worker runtime v2 store at ${filePath} has mismatched worker key ${key}`);
    }
    workers[key] = { version: STORE_VERSION, ...signal };
  }

  const processedSignalIds: Record<string, Record<string, string[]>> = {};
  for (const [workerKey, epochValue] of Object.entries(value.processedSignalIds)) {
    validatePositiveSafeIntegerString(workerKey, 'processedSignalIds worker key');
    if (!isRecord(epochValue)) {
      throw new Error(`Worker runtime v2 store at ${filePath} has invalid processed signal history for worker ${workerKey}`);
    }
    const byEpoch: Record<string, string[]> = {};
    for (const [epoch, signalIds] of Object.entries(epochValue)) {
      validateRequiredString(epoch, 'processed lifecycleEpoch', MAX_ID_LENGTH);
      if (!Array.isArray(signalIds)) {
        throw new Error(`Worker runtime v2 store at ${filePath} has invalid processed signals for worker ${workerKey}`);
      }
      byEpoch[epoch] = signalIds.map((signalId, index) => {
        validateRequiredString(signalId, `processed signalId[${index}]`, MAX_ID_LENGTH);
        return signalId;
      });
    }
    processedSignalIds[workerKey] = byEpoch;
  }

  const pendingCompatibilityClears: Record<string, string[]> = {};
  for (const [workerKey, sessionNames] of Object.entries(value.pendingCompatibilityClears)) {
    validatePositiveSafeIntegerString(workerKey, 'pending compatibility worker key');
    if (!Array.isArray(sessionNames)) {
      throw new Error(`Worker runtime v2 store at ${filePath} has invalid pending compatibility clears for worker ${workerKey}`);
    }
    pendingCompatibilityClears[workerKey] = sessionNames.map((sessionName, index) => {
      validateRequiredString(sessionName, `pending compatibility sessionName[${index}]`, MAX_SESSION_LENGTH);
      return sessionName;
    });
  }
  return {
    version: STORE_VERSION,
    workers,
    processedSignalIds,
    pendingCompatibilityClears,
  };
}

function emptyStore(): WorkerRuntimeStateFileV2 {
  return {
    version: STORE_VERSION,
    workers: {},
    processedSignalIds: {},
    pendingCompatibilityClears: {},
  };
}

function validateWorkerId(workerId: number): void {
  if (!Number.isSafeInteger(workerId) || workerId <= 0) {
    throw new Error('Worker runtime v2 workerId must be a positive safe integer');
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Worker runtime v2 ${field} must be a non-negative safe integer`);
  }
}

function validatePositiveSafeIntegerString(value: string, field: string): void {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`Worker runtime v2 ${field} must be a positive safe integer`);
  }
}

function validateRequiredString(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Worker runtime v2 ${field} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateOptionalString(value: unknown, field: string, maxLength: number): void {
  if (value !== undefined) validateRequiredString(value, field, maxLength);
}

function validateNullableId(value: unknown, field: string): void {
  if (value !== null) validateRequiredString(value, field, MAX_ID_LENGTH);
}

function validateOptionalNullableString(value: unknown, field: string, maxLength: number): void {
  if (value !== undefined && value !== null) validateRequiredString(value, field, maxLength);
}

function validateState(value: unknown): asserts value is WorkerRuntimeState {
  if (value !== 'unknown' && value !== 'running' && value !== 'idle' && value !== 'needs-input' && value !== 'error') {
    throw new Error(`Invalid worker runtime v2 state "${String(value)}"`);
  }
}

function validateOrigin(value: unknown): asserts value is WorkerRuntimeSignalOriginV2 {
  if (value !== 'lifecycle' && value !== 'hook' && value !== 'codex-transcript' && value !== 'manual') {
    throw new Error(`Invalid worker runtime v2 origin "${String(value)}"`);
  }
}

function validateTimestamp(value: unknown, field: string): void {
  validateRequiredString(value, field, MAX_ID_LENGTH);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Worker runtime v2 ${field} must be a valid timestamp`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function removeStaleLock(lockDir: string): void {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // The lock disappeared between checks.
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
