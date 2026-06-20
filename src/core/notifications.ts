import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';

export type NotificationKind = 'complete' | 'needs-input' | 'error' | 'blocked' | 'info';

export type NotificationAction =
  | { type: 'open-session'; session: string }
  | { type: 'review-diff'; session: string };

export interface HydraNotification {
  id: string;
  createdAt: string;
  readAt: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  targetSession: string | null;
  sourceSession: string | null;
  dedupeKey?: string;
  action?: NotificationAction;
  context?: {
    workerId?: number;
    branch?: string | null;
    workdir?: string | null;
    agent?: string | null;
  };
}

interface NotificationStoreFile {
  version: 1;
  notifications: HydraNotification[];
}

export interface CreateNotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  targetSession?: string | null;
  sourceSession?: string | null;
  dedupeKey?: string;
  action?: NotificationAction;
  context?: HydraNotification['context'];
}

export interface CreateNotificationResult {
  notification: HydraNotification;
  created: boolean;
}

export interface NotificationListFilters {
  session?: string;
  targetSession?: string;
  sourceSession?: string;
  kind?: NotificationKind;
  unread?: boolean;
  limit?: number;
}

export interface NotificationListResult {
  notifications: HydraNotification[];
  count: number;
  unreadCount: number;
  totalCount: number;
}

export interface NotificationReadResult {
  notification: HydraNotification;
  markedRead: number;
}

export interface NotificationClearResult {
  cleared: number;
}

export interface NotificationOpenResult {
  notification: HydraNotification;
  action: NotificationAction | null;
  opened: false;
  markedRead: number;
}

const STORE_VERSION = 1;
const DEFAULT_RETENTION_LIMIT = 1000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2000;
const MAX_SESSION_LENGTH = 200;
const MAX_DEDUPE_KEY_LENGTH = 500;

export function getHydraNotificationsFile(): string {
  return path.join(getHydraHome(), 'notifications.json');
}

export class NotificationStore {
  constructor(
    private readonly filePath: string = getHydraNotificationsFile(),
    private readonly retentionLimit: number = DEFAULT_RETENTION_LIMIT,
  ) {}

  create(input: CreateNotificationInput): CreateNotificationResult {
    return this.withLock(() => {
      const store = this.readStore();
      const dedupeKey = normalizeOptionalString(input.dedupeKey, MAX_DEDUPE_KEY_LENGTH);
      if (dedupeKey) {
        const existing = store.notifications.find(notification => notification.dedupeKey === dedupeKey);
        if (existing) {
          return { notification: existing, created: false };
        }
      }

      const notification: HydraNotification = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        readAt: null,
        kind: input.kind,
        title: truncate(input.title.trim() || 'Notification', MAX_TITLE_LENGTH),
        body: truncate(input.body?.trim() || '', MAX_BODY_LENGTH),
        targetSession: normalizeOptionalString(input.targetSession, MAX_SESSION_LENGTH),
        sourceSession: normalizeOptionalString(input.sourceSession, MAX_SESSION_LENGTH),
      };

      if (dedupeKey) {
        notification.dedupeKey = dedupeKey;
      }
      if (input.action) {
        notification.action = normalizeAction(input.action);
      }
      const context = normalizeContext(input.context);
      if (context) {
        notification.context = context;
      }

      store.notifications = [notification, ...store.notifications].slice(0, this.retentionLimit);
      this.writeStore(store);
      return { notification, created: true };
    });
  }

  list(filters: NotificationListFilters = {}): NotificationListResult {
    const store = this.readStore();
    let notifications = store.notifications.filter(notification => matchesFilters(notification, filters));
    if (filters.limit != null) {
      notifications = notifications.slice(0, filters.limit);
    }
    return {
      notifications,
      count: notifications.length,
      unreadCount: store.notifications.filter(notification => notification.readAt === null).length,
      totalCount: store.notifications.length,
    };
  }

  markRead(id: string): NotificationReadResult {
    return this.withLock(() => {
      const store = this.readStore();
      const index = store.notifications.findIndex(notification => notification.id === id);
      if (index < 0) {
        throw new Error(`Notification "${id}" not found`);
      }
      const existing = store.notifications[index];
      if (existing.readAt) {
        return { notification: existing, markedRead: 0 };
      }
      const updated = { ...existing, readAt: new Date().toISOString() };
      store.notifications[index] = updated;
      this.writeStore(store);
      return { notification: updated, markedRead: 1 };
    });
  }

  clear(filters: Pick<NotificationListFilters, 'session' | 'targetSession' | 'sourceSession'> = {}): NotificationClearResult {
    return this.withLock(() => {
      const store = this.readStore();
      const before = store.notifications.length;
      store.notifications = store.notifications.filter(notification => !matchesFilters(notification, filters));
      const cleared = before - store.notifications.length;
      if (cleared > 0) {
        this.writeStore(store);
      }
      return { cleared };
    });
  }

  open(id: string): NotificationOpenResult {
    const read = this.markRead(id);
    return {
      notification: read.notification,
      action: read.notification.action ?? null,
      opened: false,
      markedRead: read.markedRead,
    };
  }

  private readStore(): NotificationStoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { version: STORE_VERSION, notifications: [] };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Notification store at ${this.filePath} is not valid JSON`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Notification store at ${this.filePath} has invalid shape`);
    }
    const store = parsed as Partial<NotificationStoreFile>;
    if (store.version !== STORE_VERSION || !Array.isArray(store.notifications)) {
      throw new Error(`Notification store at ${this.filePath} has unsupported version or shape`);
    }

    return {
      version: STORE_VERSION,
      notifications: store.notifications.filter(isHydraNotification),
    };
  }

  private writeStore(store: NotificationStoreFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    const content = `${JSON.stringify(store, null, 2)}\n`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const lockDir = path.join(dir, 'notifications.lock');
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
          throw new Error(`Timed out waiting for notification store lock at ${lockDir}`);
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

function matchesFilters(notification: HydraNotification, filters: NotificationListFilters): boolean {
  if (filters.session && notification.targetSession !== filters.session && notification.sourceSession !== filters.session) {
    return false;
  }
  if (filters.targetSession && notification.targetSession !== filters.targetSession) {
    return false;
  }
  if (filters.sourceSession && notification.sourceSession !== filters.sourceSession) {
    return false;
  }
  if (filters.kind && notification.kind !== filters.kind) {
    return false;
  }
  if (filters.unread && notification.readAt !== null) {
    return false;
  }
  return true;
}

function isHydraNotification(value: unknown): value is HydraNotification {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<HydraNotification>;
  return typeof item.id === 'string'
    && typeof item.createdAt === 'string'
    && (typeof item.readAt === 'string' || item.readAt === null)
    && isNotificationKind(item.kind)
    && typeof item.title === 'string'
    && typeof item.body === 'string';
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return value === 'complete'
    || value === 'needs-input'
    || value === 'error'
    || value === 'blocked'
    || value === 'info';
}

function normalizeAction(action: NotificationAction): NotificationAction {
  const session = truncate(action.session.trim(), MAX_SESSION_LENGTH);
  if (!session) {
    throw new Error('Notification action session is required');
  }
  if (action.type !== 'open-session' && action.type !== 'review-diff') {
    throw new Error(`Unsupported notification action type "${(action as { type: string }).type}"`);
  }
  return { type: action.type, session };
}

function normalizeContext(context: HydraNotification['context']): HydraNotification['context'] | undefined {
  if (!context) {
    return undefined;
  }
  const normalized: NonNullable<HydraNotification['context']> = {};
  if (typeof context.workerId === 'number' && Number.isFinite(context.workerId)) {
    normalized.workerId = context.workerId;
  }
  if (context.branch !== undefined) {
    normalized.branch = normalizeOptionalString(context.branch, MAX_BODY_LENGTH);
  }
  if (context.workdir !== undefined) {
    normalized.workdir = normalizeOptionalString(context.workdir, MAX_BODY_LENGTH);
  }
  if (context.agent !== undefined) {
    normalized.agent = normalizeOptionalString(context.agent, MAX_SESSION_LENGTH);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, maxLength) : null;
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
    // The lock disappeared between mkdir attempts.
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
