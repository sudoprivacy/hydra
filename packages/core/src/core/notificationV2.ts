import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHydraHome } from './path';
import type {
  NotificationAction,
  NotificationClearFilters,
  NotificationKind,
} from './notifications';

export type NotificationStatus = 'active' | 'resolved' | 'superseded' | 'dismissed';

export interface HydraNotificationV2 {
  version: 2;
  id: string;
  occurrenceId: string;
  workerId: number;
  lifecycleEpoch: string;
  runId: string;
  signalId: string;
  kind: NotificationKind;
  status: NotificationStatus;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  sourceSession: string;
  targetSession: string | null;
  action?: NotificationAction;
}

export interface NotificationScopeTombstoneV2 {
  id: string;
  createdAt: string;
  throughEventSequence: number;
  filters: NotificationClearFilters;
}

export interface NotificationStoreFileV2 {
  version: 2;
  notifications: HydraNotificationV2[];
  tombstones: NotificationScopeTombstoneV2[];
  signalReceipts: Record<string, NotificationSignalReceiptV2>;
  pendingCompatibility: Record<string, NotificationCompatibilityOperation>;
}

export interface NotificationSignalReceiptV2 {
  id: string;
  occurrenceId: string;
  workerId: number;
  lifecycleEpoch: string;
  runId: string;
  signalId: string;
  kind: NotificationKind;
  status: NotificationStatus;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  sourceSession: string;
  targetSession: string | null;
}

export type NotificationCompatibilityOperation = 'upsert' | 'update-if-present' | 'remove';

export type CreateNotificationV2Input = Omit<HydraNotificationV2, 'version' | 'status' | 'readAt' | 'resolvedAt' | 'dismissedAt'>;

export interface NotificationV2CreateResult {
  notification: HydraNotificationV2;
  created: boolean;
}

export interface NotificationV2MutationResult {
  notification: HydraNotificationV2;
  changed: boolean;
}

export interface NotificationV2ClearResult {
  cleared: number;
  notifications: HydraNotificationV2[];
  tombstone: NotificationScopeTombstoneV2;
}

const STORE_VERSION = 2;
const DEFAULT_HISTORY_LIMIT = 1000;
const DEFAULT_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;
const MAX_ID_LENGTH = 500;
const MAX_SESSION_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2000;

export function getHydraNotificationsFileV2(): string {
  return path.join(getHydraHome(), 'notifications-v2.json');
}

export class NotificationStoreV2 {
  constructor(
    private readonly filePath: string = getHydraNotificationsFileV2(),
    private readonly historyLimit: number = DEFAULT_HISTORY_LIMIT,
    private readonly historyAgeMs: number = DEFAULT_HISTORY_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): HydraNotificationV2 | undefined {
    validateRequiredString(id, 'id', MAX_ID_LENGTH);
    const notification = this.readStore().notifications.find(item => item.id === id);
    return notification ? cloneNotificationV2(notification) : undefined;
  }

  snapshot(): NotificationStoreFileV2 {
    return cloneStore(this.readStore());
  }

  list(status?: NotificationStatus): HydraNotificationV2[] {
    return this.readStore().notifications
      .filter(notification => status === undefined || notification.status === status)
      .sort(compareNewestFirst)
      .map(cloneNotificationV2);
  }

  listTombstones(): NotificationScopeTombstoneV2[] {
    return this.readStore().tombstones.map(cloneTombstone);
  }

  listSignalReceipts(): NotificationSignalReceiptV2[] {
    return Object.values(this.readStore().signalReceipts).map(receipt => ({ ...receipt }));
  }

  getPendingCompatibility(): Record<string, NotificationCompatibilityOperation> {
    return { ...this.readStore().pendingCompatibility };
  }

  acknowledgeCompatibility(expected: Readonly<Record<string, NotificationCompatibilityOperation>>): void {
    if (Object.keys(expected).length === 0) return;
    this.update(store => {
      for (const [id, operation] of Object.entries(expected)) {
        if (store.pendingCompatibility[id] === operation) delete store.pendingCompatibility[id];
      }
    });
  }

  create(input: CreateNotificationV2Input): NotificationV2CreateResult {
    validateCreateInput(input);
    return this.update(store => {
      const identityKey = signalIdentityKey(input);
      const receipt = store.signalReceipts[identityKey];
      const existing = receipt
        ? store.notifications.find(notification => notification.id === receipt.id)
        : undefined;
      if (receipt) {
        return {
          notification: existing
            ? cloneNotificationV2(existing)
            : notificationFromReceipt(receipt, input),
          created: false,
        };
      }
      if (store.notifications.some(notification => notification.id === input.id)) {
        throw new Error(`Notification v2 id "${input.id}" already exists with a different signal identity`);
      }
      if (Object.values(store.signalReceipts).some(item => item.id === input.id)) {
        throw new Error(`Notification v2 id "${input.id}" was already used by a retained signal receipt`);
      }
      if (store.notifications.some(notification => notification.occurrenceId === input.occurrenceId)) {
        throw new Error(`Notification v2 occurrenceId "${input.occurrenceId}" already exists`);
      }
      if (Object.values(store.signalReceipts).some(item => item.occurrenceId === input.occurrenceId)) {
        throw new Error(`Notification v2 occurrenceId "${input.occurrenceId}" was already used by a retained signal receipt`);
      }

      const notification: HydraNotificationV2 = {
        version: STORE_VERSION,
        ...input,
        action: input.action && { ...input.action },
        status: 'active',
        readAt: null,
        resolvedAt: null,
        dismissedAt: null,
      };
      store.notifications.push(notification);
      store.signalReceipts[identityKey] = receiptFromNotification(notification);
      store.pendingCompatibility[notification.id] = 'upsert';
      pruneHistory(store, this.historyLimit, this.historyAgeMs, this.now());
      return { notification: cloneNotificationV2(notification), created: true };
    });
  }

  markRead(id: string, readAt = new Date(this.now()).toISOString()): NotificationV2MutationResult {
    validateTimestamp(readAt, 'readAt');
    return this.mutate(id, 'update-if-present', notification => {
      if (notification.readAt) return false;
      notification.readAt = readAt;
      return true;
    });
  }

  markMatchingRead(
    filters: NotificationClearFilters,
    readAt = new Date(this.now()).toISOString(),
  ): HydraNotificationV2[] {
    validateTimestamp(readAt, 'readAt');
    return this.update(store => {
      const updated: HydraNotificationV2[] = [];
      for (const notification of store.notifications) {
        if (notification.readAt || !matchesFilters(notification, filters)) continue;
        notification.readAt = readAt;
        store.signalReceipts[signalIdentityKey(notification)] = receiptFromNotification(notification);
        store.pendingCompatibility[notification.id] = 'update-if-present';
        updated.push(cloneNotificationV2(notification));
      }
      return updated;
    });
  }

  rerouteActiveWorker(workerId: number, sourceSession: string): HydraNotificationV2[] {
    if (!Number.isSafeInteger(workerId) || workerId <= 0) {
      throw new Error('Notification v2 workerId must be a positive safe integer');
    }
    validateRequiredString(sourceSession, 'sourceSession', MAX_SESSION_LENGTH);
    return this.update(store => {
      const updated: HydraNotificationV2[] = [];
      for (const notification of store.notifications) {
        if (notification.status !== 'active' || notification.workerId !== workerId) continue;
        const previousSource = notification.sourceSession;
        let changed = false;
        if (previousSource !== sourceSession) {
          notification.sourceSession = sourceSession;
          changed = true;
        }
        if (notification.action?.session === previousSource && notification.action.session !== sourceSession) {
          notification.action = { ...notification.action, session: sourceSession };
          changed = true;
        }
        if (!changed) continue;
        store.signalReceipts[signalIdentityKey(notification)] = receiptFromNotification(notification);
        store.pendingCompatibility[notification.id] = 'update-if-present';
        updated.push(cloneNotificationV2(notification));
      }
      return updated;
    });
  }

  resolve(
    id: string,
    reason: string,
    resolvedAt = new Date(this.now()).toISOString(),
  ): NotificationV2MutationResult {
    validateRequiredString(reason, 'resolution reason', MAX_TITLE_LENGTH);
    validateTimestamp(resolvedAt, 'resolvedAt');
    return this.mutate(id, 'remove', notification => {
      if (notification.status !== 'active') return false;
      notification.status = 'resolved';
      notification.resolvedAt = resolvedAt;
      return true;
    });
  }

  supersede(id: string, resolvedAt = new Date(this.now()).toISOString()): NotificationV2MutationResult {
    validateTimestamp(resolvedAt, 'resolvedAt');
    return this.mutate(id, 'remove', notification => {
      if (notification.status !== 'active') return false;
      notification.status = 'superseded';
      notification.resolvedAt = resolvedAt;
      return true;
    });
  }

  dismiss(id: string, dismissedAt = new Date(this.now()).toISOString()): NotificationV2MutationResult {
    validateTimestamp(dismissedAt, 'dismissedAt');
    return this.mutate(id, 'remove', notification => {
      if (notification.status === 'dismissed') return false;
      notification.status = 'dismissed';
      notification.dismissedAt = dismissedAt;
      return true;
    });
  }

  clear(
    filters: NotificationClearFilters,
    throughEventSequence: number,
    createdAt = new Date(this.now()).toISOString(),
  ): NotificationV2ClearResult {
    validateFilters(filters);
    validateNonNegativeSafeInteger(throughEventSequence, 'throughEventSequence');
    validateTimestamp(createdAt, 'tombstone createdAt');
    return this.update(store => {
      const tombstone: NotificationScopeTombstoneV2 = {
        id: randomUUID(),
        createdAt,
        throughEventSequence,
        filters: { ...filters },
      };
      store.tombstones.push(tombstone);

      const notifications: HydraNotificationV2[] = [];
      for (const notification of store.notifications) {
        if (notification.status === 'dismissed' || !matchesFilters(notification, filters)) continue;
        notification.status = 'dismissed';
        notification.dismissedAt = createdAt;
        store.pendingCompatibility[notification.id] = 'remove';
        notifications.push(cloneNotificationV2(notification));
      }
      for (const receipt of Object.values(store.signalReceipts)) {
        if (receipt.status === 'dismissed' || !matchesFilters(receipt, filters)) continue;
        receipt.status = 'dismissed';
        receipt.dismissedAt = createdAt;
      }
      pruneHistory(store, this.historyLimit, this.historyAgeMs, this.now());
      return {
        cleared: notifications.length,
        notifications,
        tombstone: cloneTombstone(tombstone),
      };
    });
  }

  private mutate(
    id: string,
    compatibilityOperation: NotificationCompatibilityOperation,
    mutator: (notification: HydraNotificationV2) => boolean,
  ): NotificationV2MutationResult {
    validateRequiredString(id, 'id', MAX_ID_LENGTH);
    return this.update(store => {
      const notification = store.notifications.find(item => item.id === id);
      if (!notification) throw new Error(`Notification "${id}" not found`);
      const changed = mutator(notification);
      if (changed) {
        store.signalReceipts[signalIdentityKey(notification)] = receiptFromNotification(notification);
        store.pendingCompatibility[notification.id] = compatibilityOperation;
        pruneHistory(store, this.historyLimit, this.historyAgeMs, this.now());
      }
      return { notification: cloneNotificationV2(notification), changed };
    });
  }

  private update<T>(mutator: (store: NotificationStoreFileV2) => T): T {
    return this.withLock(() => {
      const store = this.readStore();
      const result = mutator(store);
      this.writeStore(store);
      return result;
    });
  }

  private readStore(): NotificationStoreFileV2 {
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
      throw new Error(`Notification v2 store at ${this.filePath} is not valid JSON`, { cause: error });
    }
    return parseStore(parsed, this.filePath);
  }

  private writeStore(store: NotificationStoreFileV2): void {
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
    const lockDir = path.join(directory, 'notifications-v2.lock');
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        removeStaleLock(lockDir);
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for notification v2 lock at ${lockDir}`);
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

function parseStore(value: unknown, filePath: string): NotificationStoreFileV2 {
  if (!isRecord(value)
    || value.version !== STORE_VERSION
    || !Array.isArray(value.notifications)
    || !Array.isArray(value.tombstones)
    || !isRecord(value.signalReceipts)
    || !isRecord(value.pendingCompatibility)) {
    throw new Error(`Notification v2 store at ${filePath} has unsupported version or shape`);
  }
  const notifications = value.notifications.map((item, index) => parseNotification(item, `${filePath} notification[${index}]`));
  const tombstones = value.tombstones.map((item, index) => parseTombstone(item, `${filePath} tombstone[${index}]`));
  assertUnique(notifications.map(notification => notification.id), `${filePath} notification id`);
  assertUnique(notifications.map(notification => notification.occurrenceId), `${filePath} occurrenceId`);
  assertUnique(
    notifications.map(notification => signalIdentityKey(notification)),
    `${filePath} signal identity`,
  );
  assertUnique(tombstones.map(tombstone => tombstone.id), `${filePath} tombstone id`);
  const signalReceipts: Record<string, NotificationSignalReceiptV2> = {};
  for (const [identityKey, receiptValue] of Object.entries(value.signalReceipts)) {
    const receipt = parseReceipt(receiptValue, `${filePath} signal receipt ${identityKey}`);
    if (signalIdentityKey(receipt) !== identityKey) {
      throw new Error(`Notification v2 store at ${filePath} has a mismatched signal receipt key`);
    }
    signalReceipts[identityKey] = receipt;
  }
  assertUnique(Object.values(signalReceipts).map(receipt => receipt.id), `${filePath} signal receipt notification id`);
  assertUnique(Object.values(signalReceipts).map(receipt => receipt.occurrenceId), `${filePath} signal receipt occurrenceId`);
  for (const notification of notifications) {
    const receipt = signalReceipts[signalIdentityKey(notification)];
    if (!receipt || !receiptsEqual(receipt, receiptFromNotification(notification))) {
      throw new Error(`Notification v2 store at ${filePath} is missing a matching signal receipt for ${notification.id}`);
    }
  }
  const pendingCompatibility: Record<string, NotificationCompatibilityOperation> = {};
  for (const [id, operation] of Object.entries(value.pendingCompatibility)) {
    validateRequiredString(id, 'pending compatibility notification id', MAX_ID_LENGTH);
    if (operation !== 'upsert' && operation !== 'update-if-present' && operation !== 'remove') {
      throw new Error(`Notification v2 store at ${filePath} has invalid compatibility operation for ${id}`);
    }
    pendingCompatibility[id] = operation;
  }
  return { version: STORE_VERSION, notifications, tombstones, signalReceipts, pendingCompatibility };
}

function parseReceipt(value: unknown, label: string): NotificationSignalReceiptV2 {
  if (!isRecord(value)) throw new Error(`${label} has invalid shape`);
  const receipt = value as unknown as NotificationSignalReceiptV2;
  validateRequiredString(receipt.id, 'receipt id', MAX_ID_LENGTH);
  validateRequiredString(receipt.occurrenceId, 'receipt occurrenceId', MAX_ID_LENGTH);
  if (!Number.isSafeInteger(receipt.workerId) || receipt.workerId <= 0) throw new Error(`${label} has invalid workerId`);
  validateRequiredString(receipt.lifecycleEpoch, 'receipt lifecycleEpoch', MAX_ID_LENGTH);
  validateRequiredString(receipt.runId, 'receipt runId', MAX_ID_LENGTH);
  validateRequiredString(receipt.signalId, 'receipt signalId', MAX_ID_LENGTH);
  validateKind(receipt.kind);
  validateStatus(receipt.status);
  validateTimestamp(receipt.createdAt, 'receipt createdAt');
  validateNullableTimestamp(receipt.readAt, 'receipt readAt');
  validateNullableTimestamp(receipt.resolvedAt, 'receipt resolvedAt');
  validateNullableTimestamp(receipt.dismissedAt, 'receipt dismissedAt');
  validateRequiredString(receipt.sourceSession, 'receipt sourceSession', MAX_SESSION_LENGTH);
  if (receipt.targetSession !== null) validateRequiredString(receipt.targetSession, 'receipt targetSession', MAX_SESSION_LENGTH);
  validateTerminalTimestamps(receipt, label);
  return { ...receipt };
}

function parseNotification(value: unknown, label: string): HydraNotificationV2 {
  if (!isRecord(value) || value.version !== STORE_VERSION) throw new Error(`${label} has invalid shape`);
  const notification = value as unknown as HydraNotificationV2;
  validateCreateInput(notification);
  validateStatus(notification.status);
  validateNullableTimestamp(notification.readAt, 'readAt');
  validateNullableTimestamp(notification.resolvedAt, 'resolvedAt');
  validateNullableTimestamp(notification.dismissedAt, 'dismissedAt');
  validateTerminalTimestamps(notification, label);
  return cloneNotificationV2(notification);
}

function parseTombstone(value: unknown, label: string): NotificationScopeTombstoneV2 {
  if (!isRecord(value) || !isRecord(value.filters)) throw new Error(`${label} has invalid shape`);
  validateRequiredString(value.id, 'tombstone id', MAX_ID_LENGTH);
  validateTimestamp(value.createdAt, 'tombstone createdAt');
  validateNonNegativeSafeInteger(value.throughEventSequence, 'throughEventSequence');
  const filters = value.filters as NotificationClearFilters;
  validateFilters(filters);
  return {
    id: value.id,
    createdAt: value.createdAt as string,
    throughEventSequence: value.throughEventSequence as number,
    filters: { ...filters },
  };
}

function validateCreateInput(input: CreateNotificationV2Input): void {
  validateRequiredString(input.id, 'id', MAX_ID_LENGTH);
  validateRequiredString(input.occurrenceId, 'occurrenceId', MAX_ID_LENGTH);
  if (!Number.isSafeInteger(input.workerId) || input.workerId <= 0) throw new Error('Notification v2 workerId must be a positive safe integer');
  validateRequiredString(input.lifecycleEpoch, 'lifecycleEpoch', MAX_ID_LENGTH);
  validateRequiredString(input.runId, 'runId', MAX_ID_LENGTH);
  validateRequiredString(input.signalId, 'signalId', MAX_ID_LENGTH);
  validateKind(input.kind);
  validateRequiredString(input.title, 'title', MAX_TITLE_LENGTH);
  if (typeof input.body !== 'string' || input.body.length > MAX_BODY_LENGTH) throw new Error(`Notification v2 body must be at most ${MAX_BODY_LENGTH} characters`);
  validateTimestamp(input.createdAt, 'createdAt');
  validateRequiredString(input.sourceSession, 'sourceSession', MAX_SESSION_LENGTH);
  if (input.targetSession !== null) validateRequiredString(input.targetSession, 'targetSession', MAX_SESSION_LENGTH);
  if (input.action) validateAction(input.action);
}

function validateFilters(filters: NotificationClearFilters): void {
  for (const [field, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (field !== 'session' && field !== 'targetSession' && field !== 'sourceSession' && field !== 'kind') {
      throw new Error(`Notification v2 clear filter "${field}" is not supported`);
    }
    if (field === 'kind') validateKind(value);
    else validateRequiredString(value, `clear filter ${field}`, MAX_SESSION_LENGTH);
  }
}

function validateAction(action: NotificationAction): void {
  if (action.type !== 'open-session' && action.type !== 'review-diff') {
    throw new Error(`Invalid notification v2 action "${String((action as { type?: unknown }).type)}"`);
  }
  validateRequiredString(action.session, 'action session', MAX_SESSION_LENGTH);
}

function validateKind(value: unknown): asserts value is NotificationKind {
  if (value !== 'complete' && value !== 'needs-input' && value !== 'error' && value !== 'blocked' && value !== 'info') {
    throw new Error(`Invalid notification v2 kind "${String(value)}"`);
  }
}

function validateStatus(value: unknown): asserts value is NotificationStatus {
  if (value !== 'active' && value !== 'resolved' && value !== 'superseded' && value !== 'dismissed') {
    throw new Error(`Invalid notification v2 status "${String(value)}"`);
  }
}

function validateRequiredString(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Notification v2 ${field} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function validateTimestamp(value: unknown, field: string): asserts value is string {
  validateRequiredString(value, field, MAX_ID_LENGTH);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Notification v2 ${field} must be a valid timestamp`);
}

function validateNullableTimestamp(value: unknown, field: string): void {
  if (value !== null) validateTimestamp(value, field);
}

function validateNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Notification v2 ${field} must be a non-negative safe integer`);
}

function matchesFilters(
  notification: Pick<HydraNotificationV2, 'targetSession' | 'sourceSession' | 'kind'>,
  filters: NotificationClearFilters,
): boolean {
  if (filters.session && notification.targetSession !== filters.session && notification.sourceSession !== filters.session) return false;
  if (filters.targetSession && notification.targetSession !== filters.targetSession) return false;
  if (filters.sourceSession && notification.sourceSession !== filters.sourceSession) return false;
  if (filters.kind && notification.kind !== filters.kind) return false;
  return true;
}

function pruneHistory(store: NotificationStoreFileV2, limit: number, ageMs: number, nowMs: number): void {
  const historyCutoff = nowMs - Math.max(0, ageMs);
  const active = store.notifications.filter(notification => notification.status === 'active');
  const history = store.notifications
    .filter(notification => notification.status !== 'active' && getHistoryTimestamp(notification) >= historyCutoff)
    .sort(compareHistoryNewestFirst)
    .slice(0, Math.max(0, Math.trunc(limit)));
  store.notifications = [...active, ...history].sort(compareNewestFirst);
}

function compareNewestFirst(a: HydraNotificationV2, b: HydraNotificationV2): number {
  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
}

function getHistoryTimestamp(notification: HydraNotificationV2): number {
  return Date.parse(notification.dismissedAt ?? notification.resolvedAt ?? notification.createdAt);
}

function compareHistoryNewestFirst(a: HydraNotificationV2, b: HydraNotificationV2): number {
  const timeDiff = getHistoryTimestamp(b) - getHistoryTimestamp(a);
  return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
}

function cloneNotificationV2(notification: HydraNotificationV2): HydraNotificationV2 {
  return {
    ...notification,
    action: notification.action && { ...notification.action },
  };
}

function cloneStore(store: NotificationStoreFileV2): NotificationStoreFileV2 {
  return {
    version: STORE_VERSION,
    notifications: store.notifications.map(cloneNotificationV2),
    tombstones: store.tombstones.map(cloneTombstone),
    signalReceipts: Object.fromEntries(
      Object.entries(store.signalReceipts).map(([key, receipt]) => [key, { ...receipt }]),
    ),
    pendingCompatibility: { ...store.pendingCompatibility },
  };
}

function cloneTombstone(tombstone: NotificationScopeTombstoneV2): NotificationScopeTombstoneV2 {
  return { ...tombstone, filters: { ...tombstone.filters } };
}

function signalIdentityKey(
  notification: Pick<HydraNotificationV2, 'workerId' | 'lifecycleEpoch' | 'runId' | 'signalId'>,
): string {
  return JSON.stringify([
    notification.workerId,
    notification.lifecycleEpoch,
    notification.runId,
    notification.signalId,
  ]);
}

function receiptFromNotification(notification: HydraNotificationV2): NotificationSignalReceiptV2 {
  return {
    id: notification.id,
    occurrenceId: notification.occurrenceId,
    workerId: notification.workerId,
    lifecycleEpoch: notification.lifecycleEpoch,
    runId: notification.runId,
    signalId: notification.signalId,
    kind: notification.kind,
    status: notification.status,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    resolvedAt: notification.resolvedAt,
    dismissedAt: notification.dismissedAt,
    sourceSession: notification.sourceSession,
    targetSession: notification.targetSession,
  };
}

function receiptsEqual(a: NotificationSignalReceiptV2, b: NotificationSignalReceiptV2): boolean {
  return a.id === b.id
    && a.occurrenceId === b.occurrenceId
    && a.workerId === b.workerId
    && a.lifecycleEpoch === b.lifecycleEpoch
    && a.runId === b.runId
    && a.signalId === b.signalId
    && a.kind === b.kind
    && a.status === b.status
    && a.createdAt === b.createdAt
    && a.readAt === b.readAt
    && a.resolvedAt === b.resolvedAt
    && a.dismissedAt === b.dismissedAt
    && a.sourceSession === b.sourceSession
    && a.targetSession === b.targetSession;
}

function notificationFromReceipt(
  receipt: NotificationSignalReceiptV2,
  input: CreateNotificationV2Input,
): HydraNotificationV2 {
  return {
    version: STORE_VERSION,
    ...input,
    id: receipt.id,
    occurrenceId: receipt.occurrenceId,
    workerId: receipt.workerId,
    lifecycleEpoch: receipt.lifecycleEpoch,
    runId: receipt.runId,
    signalId: receipt.signalId,
    kind: receipt.kind,
    status: receipt.status,
    createdAt: receipt.createdAt,
    readAt: receipt.readAt,
    resolvedAt: receipt.resolvedAt,
    dismissedAt: receipt.dismissedAt,
    sourceSession: receipt.sourceSession,
    targetSession: receipt.targetSession,
    action: input.action && { ...input.action },
  };
}

function validateTerminalTimestamps(
  notification: Pick<HydraNotificationV2, 'status' | 'resolvedAt' | 'dismissedAt'>,
  label: string,
): void {
  if (notification.status === 'active' && (notification.resolvedAt !== null || notification.dismissedAt !== null)) {
    throw new Error(`${label} has terminal timestamps while active`);
  }
  if ((notification.status === 'resolved' || notification.status === 'superseded') && notification.resolvedAt === null) {
    throw new Error(`${label} is ${notification.status} without resolvedAt`);
  }
  if ((notification.status === 'resolved' || notification.status === 'superseded') && notification.dismissedAt !== null) {
    throw new Error(`${label} is ${notification.status} with dismissedAt`);
  }
  if (notification.status === 'dismissed' && notification.dismissedAt === null) {
    throw new Error(`${label} is dismissed without dismissedAt`);
  }
}

function emptyStore(): NotificationStoreFileV2 {
  return {
    version: STORE_VERSION,
    notifications: [],
    tombstones: [],
    signalReceipts: {},
    pendingCompatibility: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Notification v2 store contains duplicate ${label}`);
}

function removeStaleLock(lockDir: string): void {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
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
