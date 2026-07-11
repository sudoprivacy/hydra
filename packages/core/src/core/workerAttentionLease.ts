import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';

export type WorkerAttentionProducerKind = 'sidecar' | 'extension';

export interface WorkerAttentionLease {
  version: 1;
  ownerId: string;
  ownerKind: WorkerAttentionProducerKind;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

const LEASE_VERSION = 1;
const DEFAULT_TTL_MS = 6000;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30000;
const MAX_OWNER_ID_LENGTH = 500;

export function getHydraWorkerAttentionLeaseFile(): string {
  return path.join(getHydraHome(), 'worker-attention-supervisor-lease.json');
}

export class WorkerAttentionLeaseStore {
  constructor(
    private readonly filePath: string = getHydraWorkerAttentionLeaseFile(),
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(
    ownerKind: WorkerAttentionProducerKind,
    ownerId: string,
    ttlMs = DEFAULT_TTL_MS,
  ): WorkerAttentionLease | undefined {
    validateOwner(ownerKind, ownerId);
    validateTtl(ttlMs);
    return this.withLock(() => {
      const current = this.readLease();
      const now = this.currentTime();
      const currentIsLive = current && Date.parse(current.expiresAt) > now;
      const sameOwner = current?.ownerId === ownerId && current.ownerKind === ownerKind;
      const continuesCurrentLease = !!currentIsLive && sameOwner;
      const sidecarPreemptsExtension = ownerKind === 'sidecar'
        && current?.ownerKind === 'extension';
      if (currentIsLive && !sameOwner && !sidecarPreemptsExtension) return undefined;

      const lease = createLease(
        ownerKind,
        ownerId,
        continuesCurrentLease ? current!.generation : (current?.generation ?? 0) + 1,
        continuesCurrentLease ? current!.acquiredAt : timestamp(now),
        now,
        ttlMs,
      );
      this.writeLease(lease);
      return { ...lease };
    });
  }

  renew(lease: WorkerAttentionLease, ttlMs = DEFAULT_TTL_MS): WorkerAttentionLease | undefined {
    validateLease(lease, this.filePath);
    validateTtl(ttlMs);
    return this.withLock(() => {
      const current = this.readLease();
      if (!current || !sameLeaseOwner(current, lease)) return undefined;
      const now = this.currentTime();
      if (Date.parse(current.expiresAt) <= now) return undefined;
      const renewed = createLease(
        current.ownerKind,
        current.ownerId,
        current.generation,
        current.acquiredAt,
        now,
        ttlMs,
      );
      this.writeLease(renewed);
      return { ...renewed };
    });
  }

  isCurrent(lease: WorkerAttentionLease): boolean {
    validateLease(lease, this.filePath);
    return this.withLock(() => {
      const current = this.readLease();
      return !!current
        && sameLeaseOwner(current, lease)
        && Date.parse(current.expiresAt) > this.currentTime();
    });
  }

  release(lease: WorkerAttentionLease): boolean {
    validateLease(lease, this.filePath);
    return this.withLock(() => {
      const current = this.readLease();
      if (!current || !sameLeaseOwner(current, lease)) return false;
      fs.rmSync(this.filePath, { force: true });
      return true;
    });
  }

  inspect(): WorkerAttentionLease | undefined {
    const lease = this.readLease();
    return lease ? { ...lease } : undefined;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('Worker attention lease clock returned a non-finite value');
    return Math.trunc(value);
  }

  private readLease(): WorkerAttentionLease | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Worker attention lease at ${this.filePath} is not valid JSON`, { cause: error });
    }
    validateLease(parsed, this.filePath);
    return parsed;
  }

  private writeLease(lease: WorkerAttentionLease): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(lease, null, 2)}\n`, 'utf-8');
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private withLock<T>(fn: () => T): T {
    const lockDirectory = `${this.filePath}.lock`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDirectory);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        removeStaleLock(lockDirectory);
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for worker attention lease lock at ${lockDirectory}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  }
}

function createLease(
  ownerKind: WorkerAttentionProducerKind,
  ownerId: string,
  generation: number,
  acquiredAt: string,
  now: number,
  ttlMs: number,
): WorkerAttentionLease {
  return {
    version: LEASE_VERSION,
    ownerKind,
    ownerId,
    generation,
    acquiredAt,
    heartbeatAt: timestamp(now),
    expiresAt: timestamp(now + ttlMs),
  };
}

function sameLeaseOwner(a: WorkerAttentionLease, b: WorkerAttentionLease): boolean {
  return a.ownerId === b.ownerId
    && a.ownerKind === b.ownerKind
    && a.generation === b.generation;
}

function validateLease(value: unknown, filePath: string): asserts value is WorkerAttentionLease {
  if (!isRecord(value) || value.version !== LEASE_VERSION) {
    throw new Error(`Worker attention lease at ${filePath} has unsupported version or shape`);
  }
  validateOwner(value.ownerKind, value.ownerId);
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new Error(`Worker attention lease at ${filePath} has invalid generation`);
  }
  validateTimestamp(value.acquiredAt, `${filePath} acquiredAt`);
  validateTimestamp(value.heartbeatAt, `${filePath} heartbeatAt`);
  validateTimestamp(value.expiresAt, `${filePath} expiresAt`);
  if (Date.parse(value.expiresAt as string) <= Date.parse(value.heartbeatAt as string)) {
    throw new Error(`Worker attention lease at ${filePath} expires before its heartbeat`);
  }
}

function validateOwner(kind: unknown, ownerId: unknown): asserts kind is WorkerAttentionProducerKind {
  if (kind !== 'sidecar' && kind !== 'extension') {
    throw new Error('Worker attention producer kind must be sidecar or extension');
  }
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > MAX_OWNER_ID_LENGTH) {
    throw new Error('Worker attention lease ownerId must be a non-empty bounded string');
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 500 || ttlMs > 60000) {
    throw new Error('Worker attention lease ttl must be an integer between 500 and 60000 milliseconds');
  }
}

function validateTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Worker attention lease ${label} must be a valid timestamp`);
  }
}

function timestamp(value: number): string {
  return new Date(value).toISOString();
}

function removeStaleLock(lockDirectory: string): void {
  try {
    const stat = fs.statSync(lockDirectory);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  } catch {
    // The lock was released between the failed acquire and stale check.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
