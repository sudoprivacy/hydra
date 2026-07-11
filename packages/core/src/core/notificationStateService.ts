import * as fs from 'fs';
import {
  EventLog,
  getHydraEventsFile,
  type HydraEvent,
  type HydraEventSource,
} from './events';
import { logger } from './logger';
import type { EventHub } from './eventHub';
import {
  getHydraNotificationsFile,
  NotificationStore,
  type HydraNotification,
  type NotificationKind,
  type NotificationClearFilters,
  type NotificationReadFilters,
  type NotificationMarkSessionReadResult,
  type NotificationClearResult,
  type NotificationOpenResult,
  type NotificationReadResult,
  type NotificationStatusMutationResult,
} from './notifications';
import {
  buildNotificationState,
  cloneNotification,
  cloneSnapshot,
  getLatestNotifications,
  type NotificationSnapshot,
  type NotificationState,
} from './notificationState';

export interface Disposable {
  dispose(): void;
}

export interface NotificationStateServiceOptions {
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly notificationsFile?: string;
  readonly eventsFile?: string;
  readonly store?: NotificationStore;
  readonly eventLog?: EventLog;
  readonly eventHub?: EventHub;
}

type NotificationSnapshotListener = (snapshot: NotificationSnapshot) => void;

const DEFAULT_RELOAD_DEBOUNCE_MS = 150;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export class NotificationStateService implements Disposable {
  private readonly store: NotificationStore;
  private readonly eventLog: EventLog;
  private readonly eventHub: EventHub | undefined;
  private readonly notificationsFile: string;
  private readonly eventsFile: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<NotificationSnapshotListener>();
  private state: NotificationState = buildNotificationState([], 0);
  private initialized = false;
  private disposed = false;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEventSeq = 0;
  private lastNotificationSignature = 'missing';
  private lastEventSignature = 'missing';
  private lastMalformedEventSignature: string | undefined;
  private eventIterator: AsyncIterableIterator<HydraEvent> | undefined;
  private sourceAttentionBySession = new Map<string, HydraNotification>();
  private sourceCompletionBySession = new Map<string, HydraNotification>();
  private readonly notificationFileListener = (current: fs.Stats, previous: fs.Stats) => {
    if (!this.didStatChange(current, previous)) {
      return;
    }
    this.handleNotificationFileChange();
  };
  private readonly eventFileListener = (current: fs.Stats, previous: fs.Stats) => {
    if (!this.didStatChange(current, previous)) {
      return;
    }
    this.handleEventFileChange();
  };

  constructor(options: NotificationStateServiceOptions = {}) {
    this.notificationsFile = options.notificationsFile ?? getHydraNotificationsFile();
    this.eventsFile = options.eventsFile ?? getHydraEventsFile();
    this.eventLog = options.eventLog ?? new EventLog(this.eventsFile);
    this.eventHub = options.eventHub;
    this.store = options.store ?? new NotificationStore(this.notificationsFile, undefined, this.eventLog);
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS));
    this.pollIntervalMs = Math.max(50, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.disposed = false;
    this.initialized = true;
    const initialNotificationSignature = getFileSignature(this.notificationsFile);
    this.lastNotificationSignature = initialNotificationSignature;
    this.lastEventSignature = getFileSignature(this.eventsFile);
    const baselineSeq = this.safeReadLastSeq();
    this.lastEventSeq = baselineSeq;
    this.startWatching();
    this.reloadNow({ emit: false, reason: 'initialize' });
    if (getFileSignature(this.notificationsFile) !== initialNotificationSignature) {
      this.reloadNow({ emit: false, reason: 'initialize-signature-changed' });
    }
    if (!this.eventHub) {
      this.processEventChangesAfter(baselineSeq, { reload: 'immediate', emit: false });
    }
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    fs.unwatchFile(this.notificationsFile, this.notificationFileListener);
    if (this.eventHub) {
      void this.eventIterator?.return?.();
      this.eventIterator = undefined;
    } else {
      fs.unwatchFile(this.eventsFile, this.eventFileListener);
    }
    this.listeners.clear();
    this.disposed = true;
    this.initialized = false;
  }

  onDidChange(listener: NotificationSnapshotListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  getSnapshot(): NotificationSnapshot {
    return cloneSnapshot(this.state.snapshot);
  }

  getUnreadCount(): number {
    return this.state.snapshot.unreadCount;
  }

  getLatest(limit?: number): readonly HydraNotification[] {
    return getLatestNotifications(this.state.snapshot, limit);
  }

  getBySession(sessionName: string): readonly HydraNotification[] {
    const notifications = this.state.indexes.bySession.get(sessionName) || [];
    return notifications.map(cloneNotification);
  }

  getByTargetSession(sessionName: string): readonly HydraNotification[] {
    const notifications = this.state.indexes.byTargetSession.get(sessionName) || [];
    return notifications.map(cloneNotification);
  }

  getBySourceSession(sessionName: string): readonly HydraNotification[] {
    const notifications = this.state.indexes.bySourceSession.get(sessionName) || [];
    return notifications.map(cloneNotification);
  }

  getLatestSourceCompletion(sessionName: string): HydraNotification | undefined {
    const projected = this.sourceCompletionBySession.get(sessionName);
    if (projected) {
      return cloneNotification(projected);
    }

    return this.getLatestStoredSourceCompletion(sessionName);
  }

  getLatestSourceAttention(sessionName: string): HydraNotification | undefined {
    const projected = this.sourceAttentionBySession.get(sessionName);
    if (projected) {
      return cloneNotification(projected);
    }

    return this.getLatestStoredSourceAttention(sessionName);
  }

  getById(id: string): HydraNotification | undefined {
    const notification = this.state.indexes.byId.get(id);
    return notification ? cloneNotification(notification) : undefined;
  }

  markRead(id: string, eventSource: HydraEventSource = 'extension'): NotificationReadResult {
    const result = this.store.markRead(id, eventSource);
    this.reloadNow({ emit: true, reason: 'mark-read' });
    return result;
  }

  markSessionRead(sessionName: string, eventSource: HydraEventSource = 'extension'): NotificationMarkSessionReadResult {
    return this.markMatchingRead({ session: sessionName }, eventSource);
  }

  markMatchingRead(
    filters: NotificationReadFilters,
    eventSource: HydraEventSource = 'extension',
  ): NotificationMarkSessionReadResult {
    const result = this.store.markMatchingRead(filters, eventSource);
    this.reloadNow({ emit: true, reason: 'mark-matching-read' });
    return result;
  }

  markTargetSessionRead(sessionName: string, eventSource: HydraEventSource = 'extension'): NotificationMarkSessionReadResult {
    return this.markMatchingRead({ targetSession: sessionName }, eventSource);
  }

  clear(
    filters: NotificationClearFilters = {},
    eventSource: HydraEventSource = 'extension',
  ): NotificationClearResult {
    const result = this.store.clear(filters, eventSource);
    this.reloadNow({ emit: true, reason: 'clear' });
    return result;
  }

  open(id: string, eventSource: HydraEventSource = 'extension'): NotificationOpenResult {
    const result = this.store.open(id, eventSource);
    this.reloadNow({ emit: true, reason: 'open' });
    return result;
  }

  resolve(
    id: string,
    reason: string,
    eventSource: HydraEventSource = 'extension',
  ): NotificationStatusMutationResult {
    const result = this.store.resolve(id, reason, eventSource);
    this.reloadNow({ emit: true, reason: 'resolve' });
    return result;
  }

  dismiss(id: string, eventSource: HydraEventSource = 'extension'): NotificationStatusMutationResult {
    const result = this.store.dismiss(id, eventSource);
    this.reloadNow({ emit: true, reason: 'dismiss' });
    return result;
  }

  private startWatching(): void {
    fs.watchFile(this.notificationsFile, { interval: this.pollIntervalMs }, this.notificationFileListener);
    if (this.eventHub) {
      this.eventIterator = this.eventHub.subscribe(this.lastEventSeq);
      void this.consumeEventHub(this.eventIterator);
    } else {
      fs.watchFile(this.eventsFile, { interval: this.pollIntervalMs }, this.eventFileListener);
    }
  }

  private async consumeEventHub(iterator: AsyncIterableIterator<HydraEvent>): Promise<void> {
    try {
      for await (const event of iterator) {
        if (this.disposed) return;
        this.applyEventChanges([event], { reload: 'debounced', emit: true });
      }
    } catch (error) {
      if (!this.disposed) {
        logger.warn('notification-state.event-hub', 'Notification event subscription failed', { error });
      }
    }
  }

  private handleNotificationFileChange(): void {
    const signature = getFileSignature(this.notificationsFile);
    if (signature === this.lastNotificationSignature) {
      return;
    }
    this.lastNotificationSignature = signature;
    this.scheduleReload('notification-file');
  }

  private handleEventFileChange(): void {
    const signature = getFileSignature(this.eventsFile);
    if (signature === this.lastEventSignature) {
      return;
    }
    if (signature === this.lastMalformedEventSignature) {
      this.lastEventSignature = signature;
      return;
    }
    this.lastEventSignature = signature;
    this.processEventChangesAfter(this.lastEventSeq, { reload: 'debounced', emit: true });
  }

  private processEventChangesAfter(after: number, options: { reload: 'debounced' | 'immediate'; emit: boolean }): void {
    let events: HydraEvent[];
    try {
      events = this.eventLog.read({ after, tolerateIncompleteTail: true });
      this.lastMalformedEventSignature = undefined;
    } catch (error) {
      this.warnMalformedEventsOnce(error);
      this.lastEventSeq = this.safeReadLastSeq();
      this.reloadNow({ emit: options.emit, reason: 'event-read-fallback' });
      return;
    }

    if (events.length === 0) {
      return;
    }

    this.applyEventChanges(events, options);
  }

  private applyEventChanges(events: HydraEvent[], options: { reload: 'debounced' | 'immediate'; emit: boolean }): void {
    this.lastEventSeq = Math.max(this.lastEventSeq, ...events.map(event => event.seq));
    if (events.some(event => event.type.startsWith('notify.'))) {
      if (options.reload === 'immediate') {
        this.reloadNow({ emit: options.emit, reason: 'notification-event' });
      } else {
        this.scheduleReload('notification-event');
      }
      return;
    }

    this.state = buildNotificationState(this.state.snapshot.notifications, this.lastEventSeq);
  }

  private scheduleReload(reason: string): void {
    if (this.disposed) {
      return;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reloadNow({ emit: true, reason });
    }, this.debounceMs);
  }

  private reloadNow(options: { emit: boolean; reason: string }): void {
    if (this.disposed) {
      return;
    }

    const previousRevision = this.state.contentRevision;
    const previousAttentionRevision = buildSourceProjectionRevision(this.sourceAttentionBySession);
    const previousCompletionRevision = buildSourceCompletionRevision(this.sourceCompletionBySession);
    let notifications: HydraNotification[];
    try {
      notifications = this.store.list().notifications;
    } catch (error) {
      logger.warn('notification-state.reload', 'Failed to reload notification state', {
        reason: options.reason,
        error,
      });
      return;
    }

    this.lastNotificationSignature = getFileSignature(this.notificationsFile);
    this.lastEventSeq = Math.max(this.lastEventSeq, this.safeReadLastSeq());
    this.state = buildNotificationState(notifications, this.lastEventSeq);
    this.rebuildSourceProjections(notifications);
    const attentionRevision = buildSourceProjectionRevision(this.sourceAttentionBySession);
    const completionRevision = buildSourceCompletionRevision(this.sourceCompletionBySession);

    if (
      options.emit &&
      (
        this.state.contentRevision !== previousRevision ||
        attentionRevision !== previousAttentionRevision ||
        completionRevision !== previousCompletionRevision
      )
    ) {
      this.emitChange();
    }
  }

  private getLatestStoredSourceAttention(sessionName: string): HydraNotification | undefined {
    return [...(this.state.indexes.bySourceSession.get(sessionName) || [])]
      .filter(notification => notification.targetSession !== sessionName)
      .sort(compareSourceAttentionNotifications)
      .map(cloneNotification)[0];
  }

  private getLatestStoredSourceCompletion(sessionName: string): HydraNotification | undefined {
    return [...(this.state.indexes.bySourceSession.get(sessionName) || [])]
      .filter(notification =>
        notification.kind === 'complete' &&
        notification.targetSession !== sessionName,
      )
      .sort(compareNotificationsNewestFirst)
      .map(cloneNotification)[0];
  }

  private rebuildSourceProjections(notifications: readonly HydraNotification[]): void {
    const attention = new Map<string, HydraNotification>();
    const completions = new Map<string, HydraNotification>();

    for (const notification of notifications) {
      if (!notification.sourceSession || notification.targetSession === notification.sourceSession) {
        continue;
      }
      upsertLatestAttention(attention, notification.sourceSession, notification);
      if (notification.kind === 'complete') {
        upsertLatestCompletion(completions, notification.sourceSession, notification);
      }
    }

    this.sourceAttentionBySession = attention;
    this.sourceCompletionBySession = completions;
  }

  private emitChange(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(cloneSnapshot(snapshot));
      } catch (error) {
        logger.warn('notification-state.listener', 'Notification state listener failed', { error });
      }
    }
  }

  private safeReadLastSeq(): number {
    try {
      return this.eventLog.readLastSeq();
    } catch (error) {
      logger.warn('notification-state.events', 'Failed to read last notification event sequence', { error });
      return this.lastEventSeq;
    }
  }

  private warnMalformedEventsOnce(error: unknown): void {
    const signature = getFileSignature(this.eventsFile);
    if (signature === this.lastMalformedEventSignature) {
      return;
    }
    this.lastMalformedEventSignature = signature;
    logger.warn('notification-state.events', 'Failed to read notification events; reloading notification store', {
      error,
    });
  }

  private didStatChange(current: fs.Stats, previous: fs.Stats): boolean {
    return getFileStatSignature(current) !== getFileStatSignature(previous);
  }
}

function getFileSignature(filePath: string): string {
  try {
    return getFileStatSignature(fs.statSync(filePath));
  } catch {
    return 'missing';
  }
}

function getFileStatSignature(stat: fs.Stats): string {
  if (stat.mtimeMs === 0 && stat.size === 0) {
    return 'missing';
  }
  return `${stat.mtimeMs}:${stat.size}`;
}

function upsertLatestCompletion(
  completions: Map<string, HydraNotification>,
  sessionName: string,
  notification: HydraNotification,
): void {
  const existing = completions.get(sessionName);
  if (!existing || compareNotificationsNewestFirst(notification, existing) < 0) {
    completions.set(sessionName, cloneNotification(notification));
  }
}

function upsertLatestAttention(
  attention: Map<string, HydraNotification>,
  sessionName: string,
  notification: HydraNotification,
): void {
  const existing = attention.get(sessionName);
  if (!existing || compareSourceAttentionNotifications(notification, existing) < 0) {
    attention.set(sessionName, cloneNotification(notification));
  }
}

const SOURCE_ATTENTION_KIND_PRIORITY: Record<NotificationKind, number> = {
  error: 0,
  blocked: 1,
  'needs-input': 2,
  complete: 3,
  info: 4,
};

function compareNotificationsNewestFirst(a: HydraNotification, b: HydraNotification): number {
  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff !== 0) {
    return timeDiff;
  }
  return b.createdAt.localeCompare(a.createdAt);
}

function compareSourceAttentionNotifications(a: HydraNotification, b: HydraNotification): number {
  const newestDiff = compareNotificationsNewestFirst(a, b);
  if (newestDiff !== 0) {
    return newestDiff;
  }

  const priorityDiff = SOURCE_ATTENTION_KIND_PRIORITY[a.kind] - SOURCE_ATTENTION_KIND_PRIORITY[b.kind];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return a.id.localeCompare(b.id);
}

function buildSourceCompletionRevision(completions: ReadonlyMap<string, HydraNotification>): string {
  return buildSourceProjectionRevision(completions);
}

function buildSourceProjectionRevision(projection: ReadonlyMap<string, HydraNotification>): string {
  return JSON.stringify([...projection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sessionName, notification]) => ({
      sessionName,
      id: notification.id,
      createdAt: notification.createdAt,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      targetSession: notification.targetSession,
      sourceSession: notification.sourceSession,
      action: notification.action ? {
        type: notification.action.type,
        session: notification.action.session,
      } : null,
    })));
}
