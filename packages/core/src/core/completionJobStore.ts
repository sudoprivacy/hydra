import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';

export type CompletionJobStatus = 'pending' | 'fired' | 'cancelled';

export interface CompletionJob {
  version: 1;
  jobId: string;
  workerId: number;
  lifecycleEpoch: string;
  runId: string;
  status: CompletionJobStatus;
  armedAt: string;
  firedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

export interface CompletionJobArmInput {
  workerId: number;
  lifecycleEpoch: string;
  runId: string;
}

export interface CompletionJobArmContext {
  runtimeActive: boolean;
  runtimeRunId: string | null;
}

export interface CompletionJobArmResult {
  job: CompletionJob;
  created: boolean;
  adopted: boolean;
}

export interface CompletionJobMutationResult {
  job: CompletionJob;
  changed: boolean;
}

export interface CompletionJobCancelFilters {
  lifecycleEpoch?: string;
  runId?: string;
}

interface CompletionJobStoreFile {
  version: 1;
  jobs: CompletionJob[];
}

const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_ID_LENGTH = 500;
const MAX_REASON_LENGTH = 500;

export function getHydraCompletionJobsFile(): string {
  return path.join(getHydraHome(), 'completion-jobs.json');
}

export class CompletionJobStore {
  constructor(
    private readonly filePath: string = getHydraCompletionJobsFile(),
    private readonly now: () => number = Date.now,
  ) {}

  get(jobId: string): CompletionJob | undefined {
    validateRequiredString(jobId, 'jobId', MAX_ID_LENGTH);
    const job = this.readStore().jobs.find(candidate => candidate.jobId === jobId);
    return job ? cloneJob(job) : undefined;
  }

  list(status?: CompletionJobStatus): CompletionJob[] {
    if (status !== undefined) validateStatus(status);
    return this.readStore().jobs
      .filter(job => status === undefined || job.status === status)
      .sort(compareNewestFirst)
      .map(cloneJob);
  }

  getForRun(workerId: number, lifecycleEpoch: string, runId: string): CompletionJob | undefined {
    validateWorkerId(workerId);
    validateRequiredString(lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
    validateRequiredString(runId, 'runId', MAX_ID_LENGTH);
    const job = this.readStore().jobs.find(candidate =>
      candidate.workerId === workerId
      && candidate.lifecycleEpoch === lifecycleEpoch
      && candidate.runId === runId,
    );
    return job ? cloneJob(job) : undefined;
  }

  getPending(workerId: number, lifecycleEpoch?: string): CompletionJob | undefined {
    validateWorkerId(workerId);
    if (lifecycleEpoch !== undefined) {
      validateRequiredString(lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
    }
    const job = this.readStore().jobs.find(candidate =>
      candidate.workerId === workerId
      && candidate.status === 'pending'
      && (lifecycleEpoch === undefined || candidate.lifecycleEpoch === lifecycleEpoch),
    );
    return job ? cloneJob(job) : undefined;
  }

  /**
   * Arm completion for a dispatch while making a concurrent first dispatch
   * converge on the same run. A pending job whose run differs from an inactive
   * runtime snapshot is treated as the in-flight canonical run and adopted.
   */
  armForDispatch(
    input: CompletionJobArmInput,
    context: CompletionJobArmContext,
  ): CompletionJobArmResult {
    validateArmInput(input);
    if (typeof context.runtimeActive !== 'boolean') {
      throw new Error('Completion job runtimeActive must be a boolean');
    }
    validateNullableId(context.runtimeRunId, 'runtimeRunId');

    return this.update(store => {
      const sameRun = store.jobs.find(job => sameRunIdentity(job, input));
      if (sameRun) {
        return { job: cloneJob(sameRun), created: false, adopted: false };
      }

      const pending = store.jobs.find(job => job.workerId === input.workerId && job.status === 'pending');
      if (pending) {
        const pendingMatchesActiveRuntime = context.runtimeActive
          && pending.lifecycleEpoch === input.lifecycleEpoch
          && pending.runId === context.runtimeRunId;
        const pendingIsConcurrentNewRun = !context.runtimeActive
          && pending.lifecycleEpoch === input.lifecycleEpoch
          && pending.runId !== context.runtimeRunId;
        if (pendingMatchesActiveRuntime || pendingIsConcurrentNewRun) {
          return { job: cloneJob(pending), created: false, adopted: pendingIsConcurrentNewRun };
        }
        cancelJobRecord(pending, 'superseded-by-new-run', timestamp(this.now()));
      }

      const job: CompletionJob = {
        version: STORE_VERSION,
        jobId: randomUUID(),
        workerId: input.workerId,
        lifecycleEpoch: input.lifecycleEpoch,
        runId: input.runId,
        status: 'pending',
        armedAt: timestamp(this.now()),
      };
      store.jobs.push(job);
      return { job: cloneJob(job), created: true, adopted: false };
    });
  }

  markFired(
    jobId: string,
    expected: CompletionJobArmInput,
  ): CompletionJobMutationResult {
    validateRequiredString(jobId, 'jobId', MAX_ID_LENGTH);
    validateArmInput(expected);
    return this.update(store => {
      const job = requireJob(store, jobId);
      assertJobIdentity(job, expected);
      if (job.status !== 'pending') {
        return { job: cloneJob(job), changed: false };
      }
      job.status = 'fired';
      job.firedAt = timestamp(this.now());
      return { job: cloneJob(job), changed: true };
    });
  }

  cancelJob(jobId: string, reason: string): CompletionJobMutationResult {
    validateRequiredString(jobId, 'jobId', MAX_ID_LENGTH);
    validateRequiredString(reason, 'cancelReason', MAX_REASON_LENGTH);
    return this.update(store => {
      const job = requireJob(store, jobId);
      if (job.status !== 'pending') {
        return { job: cloneJob(job), changed: false };
      }
      cancelJobRecord(job, reason, timestamp(this.now()));
      return { job: cloneJob(job), changed: true };
    });
  }

  cancelPending(
    workerId: number,
    reason: string,
    filters: CompletionJobCancelFilters = {},
  ): CompletionJob[] {
    validateWorkerId(workerId);
    validateRequiredString(reason, 'cancelReason', MAX_REASON_LENGTH);
    if (filters.lifecycleEpoch !== undefined) {
      validateRequiredString(filters.lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
    }
    if (filters.runId !== undefined) {
      validateRequiredString(filters.runId, 'runId', MAX_ID_LENGTH);
    }
    return this.update(store => {
      const cancelled: CompletionJob[] = [];
      const cancelledAt = timestamp(this.now());
      for (const job of store.jobs) {
        if (job.workerId !== workerId || job.status !== 'pending') continue;
        if (filters.lifecycleEpoch !== undefined && job.lifecycleEpoch !== filters.lifecycleEpoch) continue;
        if (filters.runId !== undefined && job.runId !== filters.runId) continue;
        cancelJobRecord(job, reason, cancelledAt);
        cancelled.push(cloneJob(job));
      }
      return cancelled;
    });
  }

  cancelPendingOutsideEpoch(
    workerId: number,
    lifecycleEpoch: string,
    reason: string,
  ): CompletionJob[] {
    validateWorkerId(workerId);
    validateRequiredString(lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
    validateRequiredString(reason, 'cancelReason', MAX_REASON_LENGTH);
    return this.update(store => {
      const cancelled: CompletionJob[] = [];
      const cancelledAt = timestamp(this.now());
      for (const job of store.jobs) {
        if (job.workerId !== workerId
          || job.status !== 'pending'
          || job.lifecycleEpoch === lifecycleEpoch) {
          continue;
        }
        cancelJobRecord(job, reason, cancelledAt);
        cancelled.push(cloneJob(job));
      }
      return cancelled;
    });
  }

  private update<T>(mutator: (store: CompletionJobStoreFile) => T): T {
    return this.withLock(() => {
      const store = this.readStore();
      const result = mutator(store);
      validateStore(store, this.filePath);
      this.writeStore(store);
      return result;
    });
  }

  private readStore(): CompletionJobStoreFile {
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
      throw new Error(`Completion job store at ${this.filePath} is not valid JSON`, { cause: error });
    }
    return parseStore(parsed, this.filePath);
  }

  private writeStore(store: CompletionJobStoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  }

  private withLock<T>(fn: () => T): T {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const lockDir = `${this.filePath}.lock`;
    const ownerPath = path.join(lockDir, randomUUID());
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        try {
          fs.writeFileSync(ownerPath, String(process.pid), 'utf-8');
        } catch (error) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        removeStaleLock(lockDir);
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for completion job lock at ${lockDir}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return fn();
    } finally {
      if (fs.existsSync(ownerPath)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    }
  }
}

function parseStore(value: unknown, filePath: string): CompletionJobStoreFile {
  if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.jobs)) {
    throw new Error(`Completion job store at ${filePath} has unsupported version or shape`);
  }
  const store: CompletionJobStoreFile = {
    version: STORE_VERSION,
    jobs: value.jobs.map((job, index) => parseJob(job, index, filePath)),
  };
  validateStore(store, filePath);
  return store;
}

function parseJob(value: unknown, index: number, filePath: string): CompletionJob {
  if (!isRecord(value) || value.version !== STORE_VERSION) {
    throw new Error(`Completion job store at ${filePath} contains invalid job at index ${index}`);
  }
  validateRequiredString(value.jobId, `jobs[${index}].jobId`, MAX_ID_LENGTH);
  validateWorkerId(value.workerId);
  validateRequiredString(value.lifecycleEpoch, `jobs[${index}].lifecycleEpoch`, MAX_ID_LENGTH);
  validateRequiredString(value.runId, `jobs[${index}].runId`, MAX_ID_LENGTH);
  validateStatus(value.status);
  validateTimestamp(value.armedAt, `jobs[${index}].armedAt`);
  validateOptionalTimestamp(value.firedAt, `jobs[${index}].firedAt`);
  validateOptionalTimestamp(value.cancelledAt, `jobs[${index}].cancelledAt`);
  if (value.cancelReason !== undefined) {
    validateRequiredString(value.cancelReason, `jobs[${index}].cancelReason`, MAX_REASON_LENGTH);
  }

  const job = value as unknown as CompletionJob;
  validateStatusFields(job, `jobs[${index}]`);
  return { ...job };
}

function validateStore(store: CompletionJobStoreFile, filePath: string): void {
  const jobIds = new Set<string>();
  const runIdentities = new Set<string>();
  const pendingWorkers = new Set<number>();
  for (const [index, job] of store.jobs.entries()) {
    validateJob(job, `jobs[${index}]`);
    if (jobIds.has(job.jobId)) {
      throw new Error(`Completion job store at ${filePath} contains duplicate jobId "${job.jobId}"`);
    }
    jobIds.add(job.jobId);
    const runIdentity = `${job.workerId}\0${job.lifecycleEpoch}\0${job.runId}`;
    if (runIdentities.has(runIdentity)) {
      throw new Error(`Completion job store at ${filePath} contains duplicate worker run identity`);
    }
    runIdentities.add(runIdentity);
    if (job.status === 'pending') {
      if (pendingWorkers.has(job.workerId)) {
        throw new Error(`Completion job store at ${filePath} contains multiple pending jobs for worker ${job.workerId}`);
      }
      pendingWorkers.add(job.workerId);
    }
  }
}

function validateJob(job: CompletionJob, field: string): void {
  if (job.version !== STORE_VERSION) throw new Error(`${field}.version must be ${STORE_VERSION}`);
  validateRequiredString(job.jobId, `${field}.jobId`, MAX_ID_LENGTH);
  validateWorkerId(job.workerId);
  validateRequiredString(job.lifecycleEpoch, `${field}.lifecycleEpoch`, MAX_ID_LENGTH);
  validateRequiredString(job.runId, `${field}.runId`, MAX_ID_LENGTH);
  validateStatus(job.status);
  validateTimestamp(job.armedAt, `${field}.armedAt`);
  validateOptionalTimestamp(job.firedAt, `${field}.firedAt`);
  validateOptionalTimestamp(job.cancelledAt, `${field}.cancelledAt`);
  if (job.cancelReason !== undefined) {
    validateRequiredString(job.cancelReason, `${field}.cancelReason`, MAX_REASON_LENGTH);
  }
  validateStatusFields(job, field);
}

function validateStatusFields(job: CompletionJob, field: string): void {
  if (job.status === 'pending' && (job.firedAt || job.cancelledAt || job.cancelReason)) {
    throw new Error(`${field} pending status cannot contain fired or cancellation fields`);
  }
  if (job.status === 'fired' && (!job.firedAt || job.cancelledAt || job.cancelReason)) {
    throw new Error(`${field} fired status requires only firedAt`);
  }
  if (job.status === 'cancelled' && (!job.cancelledAt || !job.cancelReason || job.firedAt)) {
    throw new Error(`${field} cancelled status requires cancelledAt and cancelReason`);
  }
}

function validateArmInput(input: CompletionJobArmInput): void {
  validateWorkerId(input.workerId);
  validateRequiredString(input.lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
  validateRequiredString(input.runId, 'runId', MAX_ID_LENGTH);
}

function sameRunIdentity(job: CompletionJob, input: CompletionJobArmInput): boolean {
  return job.workerId === input.workerId
    && job.lifecycleEpoch === input.lifecycleEpoch
    && job.runId === input.runId;
}

function assertJobIdentity(job: CompletionJob, expected: CompletionJobArmInput): void {
  if (!sameRunIdentity(job, expected)) {
    throw new Error(`Completion job "${job.jobId}" identity does not match the completion signal`);
  }
}

function requireJob(store: CompletionJobStoreFile, jobId: string): CompletionJob {
  const job = store.jobs.find(candidate => candidate.jobId === jobId);
  if (!job) throw new Error(`Completion job "${jobId}" not found`);
  return job;
}

function cancelJobRecord(job: CompletionJob, reason: string, cancelledAt: string): void {
  job.status = 'cancelled';
  job.cancelledAt = cancelledAt;
  job.cancelReason = reason;
}

function cloneJob(job: CompletionJob): CompletionJob {
  return { ...job };
}

function compareNewestFirst(a: CompletionJob, b: CompletionJob): number {
  const timeDiff = Date.parse(b.armedAt) - Date.parse(a.armedAt);
  return timeDiff !== 0 ? timeDiff : a.jobId.localeCompare(b.jobId);
}

function emptyStore(): CompletionJobStoreFile {
  return { version: STORE_VERSION, jobs: [] };
}

function validateWorkerId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('Completion job workerId must be a positive safe integer');
  }
}

function validateStatus(value: unknown): asserts value is CompletionJobStatus {
  if (value !== 'pending' && value !== 'fired' && value !== 'cancelled') {
    throw new Error(`Invalid completion job status "${String(value)}"`);
  }
}

function validateRequiredString(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Completion job ${field} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateNullableId(value: unknown, field: string): void {
  if (value !== null) validateRequiredString(value, field, MAX_ID_LENGTH);
}

function validateTimestamp(value: unknown, field: string): void {
  validateRequiredString(value, field, MAX_ID_LENGTH);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Completion job ${field} must be a valid timestamp`);
  }
}

function validateOptionalTimestamp(value: unknown, field: string): void {
  if (value !== undefined) validateTimestamp(value, field);
}

function timestamp(now: number): string {
  if (!Number.isFinite(now)) throw new Error('Completion job clock returned a non-finite timestamp');
  return new Date(Math.trunc(now)).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function removeStaleLock(lockDir: string): void {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // The lock disappeared between the failed mkdir and stale check.
  }
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}
