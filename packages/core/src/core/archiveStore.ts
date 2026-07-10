import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface ArchiveStoreState<TEntry> {
  entries: TEntry[];
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

export class ArchiveStore<TEntry> {
  constructor(
    private readonly filePath: string,
    private readonly validateEntry?: (value: unknown) => value is TEntry,
  ) {}

  list(): TEntry[] {
    return clone(this.readStore().entries);
  }

  append(entry: TEntry): void {
    this.update(state => {
      state.entries.push(clone(entry));
    });
  }

  update<T>(mutator: (state: ArchiveStoreState<TEntry>) => T): T {
    return this.withLock(() => {
      const state = this.readStore();
      const result = mutator(state);
      this.validateState(state);
      this.writeStore(state);
      return result;
    });
  }

  private readStore(): ArchiveStoreState<TEntry> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { entries: [] };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Archive store at ${this.filePath} is not valid JSON`, { cause: error });
    }
    this.validateState(parsed);
    return { entries: clone(parsed.entries) };
  }

  private validateState(value: unknown): asserts value is ArchiveStoreState<TEntry> {
    if (!isRecord(value) || !Array.isArray(value.entries)) {
      throw new Error(`Archive store at ${this.filePath} has invalid shape`);
    }
    if (!this.validateEntry) return;
    for (const [index, entry] of value.entries.entries()) {
      if (!this.validateEntry(entry)) {
        throw new Error(`Archive store at ${this.filePath} has an invalid entry at index ${index}`);
      }
    }
  }

  private writeStore(state: ArchiveStoreState<TEntry>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
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
          throw new Error(`Timed out waiting for archive store lock at ${lockDir}`);
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
