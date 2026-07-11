import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';

export type HydraEventSource = 'cli' | 'extension' | 'session-manager' | 'hook';
export type HydraEventRole = 'worker' | 'copilot';

export interface HydraEvent {
  version: 1;
  seq: number;
  bootId: string;
  ts: string;
  type: string;
  source: HydraEventSource;
  session?: string;
  role?: HydraEventRole;
  agent?: string;
  workdir?: string;
  payload?: Record<string, unknown>;
}

export interface AppendHydraEventInput {
  type: string;
  source: HydraEventSource;
  session?: string | null;
  role?: HydraEventRole | null;
  agent?: string | null;
  workdir?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface EventReadOptions {
  after?: number;
  tolerateIncompleteTail?: boolean;
}

export interface EventLogRetentionOptions {
  maxActiveBytes?: number;
  maxSegments?: number;
  maxSegmentAgeMs?: number;
}

export interface Disposable {
  dispose(): void;
}

interface EventStateFile {
  version: 1;
  lastSeq: number;
}

const EVENT_VERSION = 1;
const BOOT_ID = randomUUID();
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_TYPE_LENGTH = 120;
const MAX_STRING_LENGTH = 500;
const MAX_WORKDIR_LENGTH = 2000;
const MAX_PAYLOAD_DEPTH = 4;
const DEFAULT_MAX_ACTIVE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 16;
const DEFAULT_MAX_SEGMENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SENSITIVE_KEY_PATTERN = /(body|prompt|message|diff|content|text|token|secret|credential|password|authorization|api[_-]?key|private[_-]?key)/i;

export function getHydraEventsFile(): string {
  return path.join(getHydraHome(), 'events.jsonl');
}

export function getHydraEventsStateFile(): string {
  return path.join(getHydraHome(), 'events.state.json');
}

export class EventLog {
  private readonly appendListeners = new Set<(event: HydraEvent) => void>();
  private readonly maxActiveBytes: number;
  private readonly maxSegments: number;
  private readonly maxSegmentAgeMs: number;

  constructor(
    private readonly filePath: string = getHydraEventsFile(),
    private readonly statePath: string = getHydraEventsStateFile(),
    retention: EventLogRetentionOptions = {},
  ) {
    this.maxActiveBytes = Math.max(1, Math.trunc(retention.maxActiveBytes ?? DEFAULT_MAX_ACTIVE_BYTES));
    this.maxSegments = Math.max(0, Math.trunc(retention.maxSegments ?? DEFAULT_MAX_SEGMENTS));
    this.maxSegmentAgeMs = Math.max(0, Math.trunc(retention.maxSegmentAgeMs ?? DEFAULT_MAX_SEGMENT_AGE_MS));
  }

  append(input: AppendHydraEventInput): HydraEvent {
    const event = this.withLock(() => {
      const lastSeq = Math.max(this.readState().lastSeq, this.readLastSeqFromLog());
      this.rotateIfNeeded();
      this.pruneSegments();
      const event: HydraEvent = {
        version: EVENT_VERSION,
        seq: lastSeq + 1,
        bootId: BOOT_ID,
        ts: new Date().toISOString(),
        type: truncate(input.type.trim(), MAX_TYPE_LENGTH),
        source: input.source,
      };

      const session = normalizeOptionalString(input.session, MAX_STRING_LENGTH);
      if (session) {
        event.session = session;
      }
      if (input.role) {
        event.role = input.role;
      }
      const agent = normalizeOptionalString(input.agent, MAX_STRING_LENGTH);
      if (agent) {
        event.agent = agent;
      }
      const workdir = normalizeOptionalString(input.workdir, MAX_WORKDIR_LENGTH);
      if (workdir) {
        event.workdir = workdir;
      }
      const payload = sanitizePayload(input.payload);
      if (payload && Object.keys(payload).length > 0) {
        event.payload = payload;
      }

      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
      this.writeState({ version: EVENT_VERSION, lastSeq: event.seq });
      return event;
    });
    for (const listener of this.appendListeners) {
      try {
        listener(event);
      } catch {
        // Event persistence succeeded; listeners are best-effort wake-ups.
      }
    }
    return event;
  }

  read(options: EventReadOptions = {}): HydraEvent[] {
    return this.withLock(() => {
      const after = options.after ?? 0;
      const events: HydraEvent[] = [];
      for (const segment of this.listSegments()) {
        if (segment.endSeq <= after) continue;
        events.push(...readEventsFromFile(segment.path, after, false));
      }
      if (fs.existsSync(this.filePath)) {
        events.push(...readEventsFromFile(this.filePath, after, options.tolerateIncompleteTail === true));
      }
      return events.sort((a, b) => a.seq - b.seq);
    });
  }

  onDidAppend(listener: (event: HydraEvent) => void): Disposable {
    this.appendListeners.add(listener);
    return { dispose: () => this.appendListeners.delete(listener) };
  }

  readLastSeq(): number {
    return this.withLock(() => Math.max(this.readState().lastSeq, this.readLastSeqFromLog()));
  }

  private readState(): EventStateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { version: EVENT_VERSION, lastSeq: 0 };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version: EVENT_VERSION, lastSeq: this.readLastSeqFromLog() };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { version: EVENT_VERSION, lastSeq: this.readLastSeqFromLog() };
    }
    const state = parsed as Partial<EventStateFile>;
    if (state.version !== EVENT_VERSION || typeof state.lastSeq !== 'number' || !Number.isFinite(state.lastSeq)) {
      return { version: EVENT_VERSION, lastSeq: this.readLastSeqFromLog() };
    }
    return { version: EVENT_VERSION, lastSeq: Math.max(0, Math.trunc(state.lastSeq)) };
  }

  private writeState(state: EventStateFile): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.statePath),
      `${path.basename(this.statePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, this.statePath);
  }

  private readLastSeqFromLog(): number {
    const segmentLastSeq = this.listSegments().reduce((max, segment) => Math.max(max, segment.endSeq), 0);
    return Math.max(segmentLastSeq, readLastSeqFromFile(this.filePath));
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.filePath) || fs.statSync(this.filePath).size < this.maxActiveBytes) return;
    const events = readEventsFromFile(this.filePath, 0, true);
    if (events.length === 0) return;
    const startSeq = events[0].seq;
    const endSeq = events[events.length - 1].seq;
    fs.renameSync(this.filePath, `${this.filePath}.${startSeq}-${endSeq}.segment`);
  }

  private pruneSegments(): void {
    const segments = this.listSegments();
    const cutoff = Date.now() - this.maxSegmentAgeMs;
    const ageEligible = segments.filter(
      segment => this.maxSegmentAgeMs === 0 || segment.mtimeMs >= cutoff,
    );
    const keep = this.maxSegments === 0 ? [] : ageEligible.slice(-this.maxSegments);
    const keepPaths = new Set(keep.map(segment => segment.path));
    for (const segment of segments) {
      if (!keepPaths.has(segment.path)) fs.rmSync(segment.path, { force: true });
    }
  }

  private listSegments(): EventSegment[] {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const segments: EventSegment[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = name.slice(prefix.length).match(/^(\d+)-(\d+)\.segment$/);
      if (!match) continue;
      const segmentPath = path.join(dir, name);
      const stat = fs.statSync(segmentPath);
      segments.push({
        path: segmentPath,
        startSeq: Number(match[1]),
        endSeq: Number(match[2]),
        mtimeMs: stat.mtimeMs,
      });
    }
    return segments.sort((a, b) => a.startSeq - b.startSeq);
  }

  private withLock<T>(fn: () => T): T {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, 'events.lock');
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
          throw new Error(`Timed out waiting for event log lock at ${lockDir}`);
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

interface EventSegment {
  path: string;
  startSeq: number;
  endSeq: number;
  mtimeMs: number;
}

function readEventsFromFile(filePath: string, after: number, tolerateIncompleteTail: boolean): HydraEvent[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const events: HydraEvent[] = [];
  const lines = raw.split(/\r?\n/);
  const lastNonEmptyIndex = findLastNonEmptyLineIndex(lines);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (tolerateIncompleteTail && index === lastNonEmptyIndex) break;
      throw new Error(`Event log at ${filePath} has invalid JSON on line ${index + 1}`);
    }
    if (!isHydraEvent(parsed)) {
      throw new Error(`Event log at ${filePath} has invalid event shape on line ${index + 1}`);
    }
    if (parsed.seq > after) events.push(parsed);
  }
  return events;
}

function readLastSeqFromFile(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return 0;
  let lastSeq = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<HydraEvent>;
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
        lastSeq = Math.max(lastSeq, Math.trunc(parsed.seq));
      }
    } catch {
      // read() is strict for consumers. Seq recovery is best effort so a
      // malformed tail does not cause the next append to reuse a sequence.
    }
  }
  return lastSeq;
}

export function readCursorFile(cursorFile: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(cursorFile, 'utf-8').trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  if (!raw) {
    return 0;
  }

  let value: unknown = raw;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { seq?: unknown; lastSeq?: unknown };
      value = parsed.seq ?? parsed.lastSeq;
    } catch {
      value = raw;
    }
  }
  const seq = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seq) || seq < 0) {
    throw new Error(`Invalid event cursor file at ${cursorFile}`);
  }
  return Math.trunc(seq);
}

export function writeCursorFile(cursorFile: string, seq: number): void {
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  const tmpPath = path.join(
    path.dirname(cursorFile),
    `${path.basename(cursorFile)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(tmpPath, `${Math.max(0, Math.trunc(seq))}\n`, 'utf-8');
  fs.renameSync(tmpPath, cursorFile);
}

function isHydraEvent(value: unknown): value is HydraEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const event = value as Partial<HydraEvent>;
  return event.version === EVENT_VERSION
    && typeof event.seq === 'number'
    && Number.isFinite(event.seq)
    && typeof event.bootId === 'string'
    && typeof event.ts === 'string'
    && typeof event.type === 'string'
    && isHydraEventSource(event.source)
    && (event.session === undefined || typeof event.session === 'string')
    && (event.role === undefined || event.role === 'worker' || event.role === 'copilot')
    && (event.agent === undefined || typeof event.agent === 'string')
    && (event.workdir === undefined || typeof event.workdir === 'string')
    && (event.payload === undefined || (typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)));
}

export function isHydraEventSource(value: unknown): value is HydraEventSource {
  return value === 'cli' || value === 'extension' || value === 'session-manager' || value === 'hook';
}

function sanitizePayload(value: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const sanitized = sanitizeObject(value, 0);
  return sanitized && !Array.isArray(sanitized) && typeof sanitized === 'object'
    ? sanitized as Record<string, unknown>
    : undefined;
}

function sanitizeObject(value: unknown, depth: number): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) {
    return '[redacted]';
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return truncate(value, MAX_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeObject(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    const sanitized = sanitizeObject(child, depth + 1);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

function normalizeOptionalString(value: string | null | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, maxLength) : undefined;
}

function findLastNonEmptyLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].trim()) {
      return index;
    }
  }
  return -1;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function tryRemoveStaleLock(lockDir: string): void {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Best effort.
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait is acceptable here because locks are local and short-lived.
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
