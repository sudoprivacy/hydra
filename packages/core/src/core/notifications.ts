import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';
import { EventLog, type HydraEventSource } from './events';
import { logger } from './logger';
import {
  NotificationStoreV2,
  type CreateNotificationV2Input,
  type HydraNotificationV2,
  type NotificationStatus,
} from './notificationV2';
import {
  WorkerRuntimeStateStoreV2,
  type WorkerRuntimeSnapshotV2,
} from './workerRuntimeV2';

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
  eventSource?: HydraEventSource;
  occurrenceId?: string;
  lifecycleEpoch?: string;
  runId?: string;
  signalId?: string;
}

export interface CreateNotificationResult {
  notification: HydraNotification;
  created: boolean;
  occurrence?: HydraNotificationV2;
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

export type NotificationClearFilters = Pick<
  NotificationListFilters,
  'session' | 'targetSession' | 'sourceSession' | 'kind'
>;

export type NotificationReadFilters = NotificationClearFilters;

export interface NotificationReadResult {
  notification: HydraNotification;
  markedRead: number;
}

export interface NotificationMarkSessionReadResult {
  notifications: HydraNotification[];
  markedRead: number;
}

export interface NotificationClearResult {
  cleared: number;
  tombstoneId?: string;
}

export interface NotificationStatusMutationResult {
  notification: HydraNotification;
  changed: boolean;
  status: NotificationStatus;
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
  private readonly v2Store: NotificationStoreV2;
  private readonly runtimeV2Store: WorkerRuntimeStateStoreV2;

  constructor(
    private readonly filePath: string = getHydraNotificationsFile(),
    private readonly retentionLimit: number = DEFAULT_RETENTION_LIMIT,
    private readonly eventLog: EventLog = new EventLog(),
    legacyRuntimeStateStore?: unknown,
    private readonly now: () => number = Date.now,
    v2Store?: NotificationStoreV2,
    runtimeV2Store?: WorkerRuntimeStateStoreV2,
  ) {
    void legacyRuntimeStateStore;
    this.v2Store = v2Store ?? new NotificationStoreV2(
      path.join(path.dirname(filePath), 'notifications-v2.json'),
      retentionLimit,
      undefined,
      now,
    );
    this.runtimeV2Store = runtimeV2Store ?? new WorkerRuntimeStateStoreV2(
      path.join(path.dirname(filePath), 'worker-runtime-state-v2.json'),
    );
  }

  create(input: CreateNotificationInput): CreateNotificationResult {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const dedupeKey = normalizeOptionalString(input.dedupeKey, MAX_DEDUPE_KEY_LENGTH);
      const canUseV2Dedupe = Number.isSafeInteger(input.context?.workerId)
        && (input.context?.workerId ?? 0) > 0
        && !!normalizeOptionalString(input.sourceSession, MAX_SESSION_LENGTH);
      if (dedupeKey && !canUseV2Dedupe) {
        const existing = store.notifications.find(notification => notification.dedupeKey === dedupeKey);
        if (existing) {
          return { notification: existing, created: false };
        }
      }

      const notification: HydraNotification = {
        id: randomUUID(),
        createdAt: getNextNotificationTimestamp(
          [
            ...store.notifications,
            ...this.v2Store.list().map(item => toLegacyNotification(item)),
          ],
          this.now(),
        ),
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

      const runtimeSnapshot = typeof notification.context?.workerId === 'number'
        ? this.runtimeV2Store.get(notification.context.workerId)
        : undefined;
      const v2Input = buildNotificationV2Input(notification, input, dedupeKey, runtimeSnapshot);
      let occurrence: HydraNotificationV2 | undefined;
      if (v2Input) {
        const v2Result = this.v2Store.create(v2Input);
        if (!v2Result.created) {
          const projected = store.notifications.find(item => item.id === v2Result.notification.id)
            ?? toLegacyNotification(v2Result.notification, notification);
          return { notification: projected, created: false, occurrence: v2Result.notification };
        }
        occurrence = v2Result.notification;
      }

      store.notifications = [notification, ...store.notifications].slice(0, this.retentionLimit);
      this.writeStore(store);
      if (occurrence) this.v2Store.acknowledgeCompatibility({ [occurrence.id]: 'upsert' });
      this.emitNotificationEvent('notify.created', notification, input.eventSource || 'cli', occurrence);
      return { notification, created: true, occurrence };
    });
  }

  list(filters: NotificationListFilters = {}): NotificationListResult {
    const store = this.readStore();
    const v2Snapshot = this.v2Store.snapshot();
    const occurrences = v2Snapshot.notifications;
    const occurrenceById = new Map(occurrences.map(notification => [notification.id, notification]));
    const receiptById = new Map(Object.values(v2Snapshot.signalReceipts).map(receipt => [receipt.id, receipt]));
    const merged = new Map<string, HydraNotification>();
    for (const notification of store.notifications) {
      const occurrence = occurrenceById.get(notification.id);
      const receipt = receiptById.get(notification.id);
      if (occurrence && occurrence.status !== 'active') continue;
      if (!occurrence && receipt && receipt.status !== 'active') continue;
      merged.set(notification.id, cloneNotification(notification));
    }
    for (const occurrence of occurrences) {
      if (occurrence.status !== 'active') continue;
      const legacy = merged.get(occurrence.id);
      merged.set(occurrence.id, toLegacyNotification(occurrence, legacy));
    }

    const allNotifications = [...merged.values()].sort(compareNotificationsNewestFirst);
    let notifications = allNotifications.filter(notification => matchesFilters(notification, filters));
    if (filters.limit != null) {
      notifications = notifications.slice(0, filters.limit);
    }
    return {
      notifications,
      count: notifications.length,
      unreadCount: allNotifications.filter(notification => notification.readAt === null).length,
      totalCount: allNotifications.length,
    };
  }

  markRead(id: string, eventSource: HydraEventSource = 'cli'): NotificationReadResult {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const index = store.notifications.findIndex(notification => notification.id === id);
      const occurrence = this.v2Store.get(id);
      if (index < 0 && !occurrence) {
        throw new Error(`Notification "${id}" not found`);
      }

      const existing = index >= 0 ? store.notifications[index] : undefined;
      const readAt = new Date(this.now()).toISOString();
      const occurrenceResult = occurrence ? this.v2Store.markRead(id, readAt) : undefined;
      const updated = occurrenceResult
        ? toLegacyNotification(occurrenceResult.notification, existing)
        : existing!.readAt
          ? cloneNotification(existing!)
          : { ...existing!, readAt };
      const changed = occurrenceResult ? occurrenceResult.changed : existing?.readAt === null;
      if (index >= 0) {
        store.notifications[index] = updated;
        if (existing?.readAt !== updated.readAt) this.writeStore(store);
      }
      if (occurrenceResult) this.v2Store.acknowledgeCompatibility({ [id]: 'update-if-present' });
      if (changed) this.emitNotificationEvent('notify.read', updated, eventSource, occurrenceResult?.notification);
      return { notification: updated, markedRead: changed ? 1 : 0 };
    });
  }

  markSessionRead(sessionName: string, eventSource: HydraEventSource = 'cli'): NotificationMarkSessionReadResult {
    return this.markMatchingRead({ session: sessionName }, eventSource);
  }

  markMatchingRead(
    filters: NotificationReadFilters,
    eventSource: HydraEventSource = 'cli',
  ): NotificationMarkSessionReadResult {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const readAt = new Date(this.now()).toISOString();
      const updatedById = new Map<string, HydraNotification>();
      const updatedOccurrences = this.v2Store.markMatchingRead(filters, readAt);
      for (const occurrence of updatedOccurrences) {
        const existing = store.notifications.find(notification => notification.id === occurrence.id);
        updatedById.set(occurrence.id, toLegacyNotification(occurrence, existing));
      }

      store.notifications = store.notifications.map(notification => {
        if (
          notification.readAt !== null ||
          !matchesFilters(notification, filters)
        ) {
          return notification;
        }
        const updated = { ...notification, readAt };
        updatedById.set(updated.id, updated);
        return updated;
      });

      const updatedNotifications = [...updatedById.values()];
      if (store.notifications.some(notification => updatedById.has(notification.id))) {
        this.writeStore(store);
      }
      this.v2Store.acknowledgeCompatibility(Object.fromEntries(
        updatedOccurrences.map(notification => [notification.id, 'update-if-present' as const]),
      ));
      for (const notification of updatedNotifications) {
        this.emitNotificationEvent('notify.read', notification, eventSource, this.v2Store.get(notification.id));
      }

      return {
        notifications: updatedNotifications,
        markedRead: updatedNotifications.length,
      };
    });
  }

  clear(
    filters: NotificationClearFilters = {},
    eventSource: HydraEventSource = 'cli',
  ): NotificationClearResult {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const throughEventSequence = this.eventLog.readLastSeq();
      const clearResult = this.v2Store.clear(
        filters,
        throughEventSequence,
        new Date(this.now()).toISOString(),
      );
      const before = store.notifications.length;
      const removedIds = new Set(
        store.notifications
          .filter(notification => matchesFilters(notification, filters))
          .map(notification => notification.id),
      );
      store.notifications = store.notifications.filter(notification => !matchesFilters(notification, filters));
      const removedFromV1 = before - store.notifications.length;
      if (removedFromV1 > 0) {
        this.writeStore(store);
      }
      this.v2Store.acknowledgeCompatibility(Object.fromEntries(
        clearResult.notifications.map(notification => [notification.id, 'remove' as const]),
      ));
      for (const notification of clearResult.notifications) removedIds.add(notification.id);
      const cleared = removedIds.size;
      this.emitClearEvent(
        cleared,
        filters,
        eventSource,
        clearResult.tombstone.id,
        throughEventSequence,
      );
      return { cleared, tombstoneId: clearResult.tombstone.id };
    });
  }

  resolve(
    id: string,
    reason: string,
    eventSource: HydraEventSource = 'session-manager',
  ): NotificationStatusMutationResult {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error('Notification resolve reason is required');
    return this.changeStatus(id, 'resolved', truncate(normalizedReason, MAX_TITLE_LENGTH), eventSource);
  }

  dismiss(
    id: string,
    eventSource: HydraEventSource = 'cli',
  ): NotificationStatusMutationResult {
    return this.changeStatus(id, 'dismissed', 'dismissed', eventSource);
  }

  supersede(
    id: string,
    reason: string,
    eventSource: HydraEventSource = 'session-manager',
  ): NotificationStatusMutationResult {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new Error('Notification supersede reason is required');
    return this.changeStatus(id, 'superseded', truncate(normalizedReason, MAX_TITLE_LENGTH), eventSource);
  }

  open(id: string, eventSource: HydraEventSource = 'cli'): NotificationOpenResult {
    const read = this.markRead(id, eventSource);
    return {
      notification: read.notification,
      action: read.notification.action ?? null,
      opened: false,
      markedRead: read.markedRead,
    };
  }

  listOccurrences(status?: NotificationStatus): HydraNotificationV2[] {
    return this.v2Store.list(status);
  }

  rerouteActiveWorker(workerId: number, sourceSession: string): HydraNotification[] {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const updatedOccurrences = this.v2Store.rerouteActiveWorker(workerId, sourceSession);
      if (updatedOccurrences.length === 0) return [];

      const updatedById = new Map(updatedOccurrences.map(notification => [notification.id, notification]));
      let compatibilityChanged = false;
      store.notifications = store.notifications.map(notification => {
        const occurrence = updatedById.get(notification.id);
        if (!occurrence) return notification;
        compatibilityChanged = true;
        return toLegacyNotification(occurrence, notification);
      });
      if (compatibilityChanged) this.writeStore(store);
      this.v2Store.acknowledgeCompatibility(Object.fromEntries(
        updatedOccurrences.map(notification => [notification.id, 'update-if-present' as const]),
      ));
      return updatedOccurrences.map(notification => {
        const legacy = store.notifications.find(item => item.id === notification.id);
        return toLegacyNotification(notification, legacy);
      });
    });
  }

  private changeStatus(
    id: string,
    status: 'resolved' | 'superseded' | 'dismissed',
    reason: string,
    eventSource: HydraEventSource,
  ): NotificationStatusMutationResult {
    return this.withLock(() => {
      const store = this.readStore();
      this.reconcileCompatibility(store);
      const existing = store.notifications.find(notification => notification.id === id);
      const changedAt = new Date(this.now()).toISOString();
      const result = status === 'resolved'
        ? this.v2Store.resolve(id, reason, changedAt)
        : status === 'superseded'
          ? this.v2Store.supersede(id, changedAt)
          : this.v2Store.dismiss(id, changedAt);
      const before = store.notifications.length;
      store.notifications = store.notifications.filter(notification => notification.id !== id);
      if (store.notifications.length !== before) this.writeStore(store);
      this.v2Store.acknowledgeCompatibility({ [id]: 'remove' });

      const notification = toLegacyNotification(result.notification, existing);
      if (result.changed) {
        this.emitNotificationEvent(
          status === 'resolved'
            ? 'notify.resolved'
            : status === 'superseded'
              ? 'notify.superseded'
              : 'notify.dismissed',
          notification,
          eventSource,
          result.notification,
          reason,
        );
      }
      return { notification, changed: result.changed, status: result.notification.status };
    });
  }

  private reconcileCompatibility(store: NotificationStoreFile): void {
    const v2Snapshot = this.v2Store.snapshot();
    const pending = v2Snapshot.pendingCompatibility;
    const pendingEntries = Object.entries(pending);
    if (pendingEntries.length === 0) return;

    const occurrences = new Map(v2Snapshot.notifications.map(notification => [notification.id, notification]));
    let changed = false;
    for (const [id, operation] of pendingEntries) {
      const index = store.notifications.findIndex(notification => notification.id === id);
      const occurrence = occurrences.get(id);
      if (operation === 'remove' || !occurrence || occurrence.status !== 'active') {
        if (index >= 0) {
          store.notifications.splice(index, 1);
          changed = true;
        }
        continue;
      }
      if (operation === 'update-if-present' && index < 0) continue;

      const projected = toLegacyNotification(occurrence, index >= 0 ? store.notifications[index] : undefined);
      if (index >= 0) {
        if (JSON.stringify(store.notifications[index]) !== JSON.stringify(projected)) {
          store.notifications[index] = projected;
          changed = true;
        }
      } else {
        store.notifications = [projected, ...store.notifications].slice(0, this.retentionLimit);
        changed = true;
      }
    }
    if (changed) this.writeStore(store);
    this.v2Store.acknowledgeCompatibility(pending);
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

  private emitNotificationEvent(
    type: 'notify.created' | 'notify.read' | 'notify.resolved' | 'notify.superseded' | 'notify.dismissed',
    notification: HydraNotification,
    source: HydraEventSource,
    occurrence?: Partial<HydraNotificationV2>,
    reason?: string,
  ): void {
    try {
      this.eventLog.append({
        type,
        source,
        session: notification.targetSession || notification.sourceSession,
        payload: {
          notificationId: notification.id,
          kind: notification.kind,
          title: notification.title,
          body: notification.body,
          targetSession: notification.targetSession,
          sourceSession: notification.sourceSession,
          actionType: notification.action?.type,
          actionSession: notification.action?.session,
          workerId: notification.context?.workerId,
          branch: notification.context?.branch,
          workdir: notification.context?.workdir,
          agent: notification.context?.agent,
          occurrenceId: occurrence?.occurrenceId,
          lifecycleEpoch: occurrence?.lifecycleEpoch,
          runId: occurrence?.runId,
          signalId: occurrence?.signalId,
          notificationStatus: occurrence?.status,
          resolvedAt: occurrence?.resolvedAt,
          dismissedAt: occurrence?.dismissedAt,
          reason,
        },
      });
    } catch (error) {
      logger.warn('notifications.event', 'Failed to append notification event', {
        type,
        notificationId: notification.id,
        error,
      });
    }
  }

  private emitClearEvent(
    cleared: number,
    filters: NotificationClearFilters,
    source: HydraEventSource,
    tombstoneId: string,
    throughEventSequence: number,
  ): void {
    try {
      this.eventLog.append({
        type: 'notify.cleared',
        source,
        session: filters.session || filters.targetSession || filters.sourceSession,
        payload: {
          cleared,
          session: filters.session,
          targetSession: filters.targetSession,
          sourceSession: filters.sourceSession,
          kind: filters.kind,
          tombstoneId,
          throughEventSequence,
        },
      });
    } catch (error) {
      logger.warn('notifications.event', 'Failed to append notification clear event', {
        cleared,
        error,
      });
    }
  }
}

function buildNotificationV2Input(
  notification: HydraNotification,
  input: CreateNotificationInput,
  dedupeKey: string | null,
  runtimeSnapshot?: WorkerRuntimeSnapshotV2,
): CreateNotificationV2Input | undefined {
  const workerId = notification.context?.workerId;
  if (!Number.isSafeInteger(workerId) || (workerId as number) <= 0 || !notification.sourceSession) {
    return undefined;
  }

  const lifecycleEpoch = normalizeOptionalString(input.lifecycleEpoch, MAX_DEDUPE_KEY_LENGTH)
    ?? runtimeSnapshot?.lifecycleEpoch
    ?? `legacy-worker-${workerId}`;
  const runId = normalizeOptionalString(input.runId, MAX_DEDUPE_KEY_LENGTH)
    ?? runtimeSnapshot?.runId
    ?? `legacy-run:${workerId}:${notification.sourceSession}`;
  const signalId = normalizeOptionalString(input.signalId, MAX_DEDUPE_KEY_LENGTH)
    ?? dedupeKey
    ?? notification.id;
  const occurrenceId = normalizeOptionalString(input.occurrenceId, MAX_DEDUPE_KEY_LENGTH)
    ?? notification.id;

  return {
    id: notification.id,
    occurrenceId,
    workerId: workerId as number,
    lifecycleEpoch,
    runId,
    signalId,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt,
    sourceSession: notification.sourceSession,
    targetSession: notification.targetSession,
    action: notification.action && { ...notification.action },
  };
}

function toLegacyNotification(
  notification: HydraNotificationV2,
  fallback?: HydraNotification,
): HydraNotification {
  const projected: HydraNotification = {
    id: notification.id,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    targetSession: notification.targetSession,
    sourceSession: notification.sourceSession,
    context: {
      ...fallback?.context,
      workerId: notification.workerId,
    },
  };
  if (fallback?.dedupeKey) projected.dedupeKey = fallback.dedupeKey;
  const action = notification.action ?? fallback?.action;
  if (action) projected.action = { ...action };
  return projected;
}

function cloneNotification(notification: HydraNotification): HydraNotification {
  return {
    ...notification,
    action: notification.action && { ...notification.action },
    context: notification.context && { ...notification.context },
  };
}

function compareNotificationsNewestFirst(a: HydraNotification, b: HydraNotification): number {
  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
}

function getNextNotificationTimestamp(notifications: readonly HydraNotification[], wallClockMs: number): string {
  let newestExistingMs = Number.NEGATIVE_INFINITY;
  for (const notification of notifications) {
    const createdAtMs = Date.parse(notification.createdAt);
    if (Number.isFinite(createdAtMs) && createdAtMs > newestExistingMs) {
      newestExistingMs = createdAtMs;
    }
  }
  const normalizedWallClockMs = Number.isFinite(wallClockMs) ? Math.trunc(wallClockMs) : Date.now();
  const logicalMs = Math.max(normalizedWallClockMs, newestExistingMs + 1);
  return new Date(logicalMs).toISOString();
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
