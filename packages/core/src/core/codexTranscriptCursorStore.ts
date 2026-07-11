import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';
import type { CodexTranscriptParserState } from './codexTranscriptParser';

export interface CodexTranscriptIdentity {
  path: string;
  device: number;
  inode: number;
}

export interface CodexTranscriptCursor {
  version: 1;
  workerId: number;
  lifecycleEpoch: string;
  transcript: CodexTranscriptIdentity;
  byteOffset: number;
  pendingBytesBase64: string;
  parserState: CodexTranscriptParserState;
  updatedAt: string;
}

interface CodexTranscriptCursorFile {
  version: 1;
  cursors: Record<string, CodexTranscriptCursor>;
}

const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_ID_LENGTH = 500;
const MAX_PATH_LENGTH = 4000;
const MAX_PENDING_BYTES_BASE64 = 16 * 1024 * 1024;

export function getHydraCodexTranscriptCursorsFile(): string {
  return path.join(getHydraHome(), 'codex-transcript-cursors.json');
}

export class CodexTranscriptCursorStore {
  constructor(private readonly filePath: string = getHydraCodexTranscriptCursorsFile()) {}

  get(workerId: number): CodexTranscriptCursor | undefined {
    validateWorkerId(workerId);
    const cursor = this.readStore().cursors[String(workerId)];
    return cursor ? cloneCursor(cursor) : undefined;
  }

  set(cursor: CodexTranscriptCursor): CodexTranscriptCursor {
    validateCursor(cursor, `${this.filePath} cursor`);
    return this.update(store => {
      store.cursors[String(cursor.workerId)] = cloneCursor(cursor);
      return cloneCursor(cursor);
    });
  }

  removeMissingWorkers(activeWorkerIds: ReadonlySet<number>): number {
    for (const workerId of activeWorkerIds) validateWorkerId(workerId);
    return this.update(store => {
      let removed = 0;
      for (const key of Object.keys(store.cursors)) {
        const workerId = Number(key);
        if (activeWorkerIds.has(workerId)) continue;
        delete store.cursors[key];
        removed += 1;
      }
      return removed;
    });
  }

  private update<T>(mutator: (store: CodexTranscriptCursorFile) => T): T {
    return this.withLock(() => {
      const store = this.readStore();
      const result = mutator(store);
      validateStore(store, this.filePath);
      this.writeStore(store);
      return result;
    });
  }

  private readStore(): CodexTranscriptCursorFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyStore();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      validateStore(parsed, this.filePath);
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Codex transcript cursor store')) throw error;
      throw new Error(`Codex transcript cursor store at ${this.filePath} is not valid JSON`, { cause: error });
    }
  }

  private writeStore(store: CodexTranscriptCursorFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
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
          throw new Error(`Timed out waiting for Codex transcript cursor lock at ${lockDirectory}`);
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

function emptyStore(): CodexTranscriptCursorFile {
  return { version: STORE_VERSION, cursors: {} };
}

function validateStore(value: unknown, filePath: string): asserts value is CodexTranscriptCursorFile {
  if (!isRecord(value)
    || value.version !== STORE_VERSION
    || !isRecord(value.cursors)) {
    throw new Error(`Codex transcript cursor store at ${filePath} has unsupported version or shape`);
  }
  for (const [key, cursor] of Object.entries(value.cursors)) {
    validateCursor(cursor, `Codex transcript cursor store at ${filePath} entry ${key}`);
    if (String(cursor.workerId) !== key) {
      throw new Error(`Codex transcript cursor store at ${filePath} has a mismatched worker key ${key}`);
    }
  }
}

function validateCursor(value: unknown, label: string): asserts value is CodexTranscriptCursor {
  if (!isRecord(value) || value.version !== STORE_VERSION) throw new Error(`${label} has invalid shape`);
  validateWorkerId(value.workerId);
  validateRequiredString(value.lifecycleEpoch, `${label} lifecycleEpoch`, MAX_ID_LENGTH);
  validateTranscriptIdentity(value.transcript, label);
  validateNonNegativeSafeInteger(value.byteOffset, `${label} byteOffset`);
  validateBase64(value.pendingBytesBase64, `${label} pendingBytesBase64`);
  validateParserState(value.parserState, label);
  validateTimestamp(value.updatedAt, `${label} updatedAt`);
}

function validateTranscriptIdentity(value: unknown, label: string): asserts value is CodexTranscriptIdentity {
  if (!isRecord(value)) throw new Error(`${label} transcript has invalid shape`);
  validateRequiredString(value.path, `${label} transcript path`, MAX_PATH_LENGTH);
  validateNonNegativeSafeInteger(value.device, `${label} transcript device`);
  validateNonNegativeSafeInteger(value.inode, `${label} transcript inode`);
}

function validateParserState(value: unknown, label: string): asserts value is CodexTranscriptParserState {
  if (!isRecord(value)) throw new Error(`${label} parserState has invalid shape`);
  validateOptionalString(value.currentTurnId, `${label} currentTurnId`);
  validateOptionalString(value.pendingCallId, `${label} pendingCallId`);
  validateOptionalString(value.lastCallId, `${label} lastCallId`);
  if (value.lastNativeSequence !== undefined) {
    validateNonNegativeSafeInteger(value.lastNativeSequence, `${label} lastNativeSequence`);
  }
}

function validateBase64(value: unknown, label: string): void {
  if (typeof value !== 'string'
    || value.length > MAX_PENDING_BYTES_BASE64
    || (value.length > 0 && (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      || Buffer.from(value, 'base64').toString('base64') !== value))) {
    throw new Error(`${label} must be bounded base64 text`);
  }
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined) validateRequiredString(value, label, MAX_ID_LENGTH);
}

function validateRequiredString(value: unknown, label: string, maxLength: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateWorkerId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('Codex transcript cursor workerId must be a positive safe integer');
  }
}

function validateNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function validateTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}

function cloneCursor(cursor: CodexTranscriptCursor): CodexTranscriptCursor {
  return {
    ...cursor,
    transcript: { ...cursor.transcript },
    parserState: { ...cursor.parserState },
  };
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
