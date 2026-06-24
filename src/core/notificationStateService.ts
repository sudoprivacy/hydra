import * as fs from 'fs';
import {
  EventLog,
  getHydraEventsFile,
  type HydraEvent,
  type HydraEventSource,
} from './events';
import { logger } from './logger';
import {
  getHydraNotificationsFile,
  isNotificationKind,
  NotificationStore,
  type HydraNotification,
  type NotificationKind,
  type NotificationMarkSessionReadResult,
  type NotificationClearResult,
  type NotificationListFilters,
  type NotificationOpenResult,
  type NotificationReadResult,
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
}

type NotificationSnapshotListener = (snapshot: NotificationSnapshot) => void;

const DEFAULT_RELOAD_DEBOUNCE_MS = 150;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export class NotificationStateService implements Disposable {
  private readonly store: NotificationStore;
  private readonly eventLog: EventLog;
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
    this.startWatching();

    const baselineSeq = this.safeReadLastSeq();
    this.lastEventSeq = baselineSeq;
    this.reloadNow({ emit: false, reason: 'initialize' });
    if (getFileSignature(this.notificationsFile) !== initialNotificationSignature) {
      this.reloadNow({ emit: false, reason: 'initialize-signature-changed' });
    }
    this.processEventChangesAfter(baselineSeq, { reload: 'immediate', emit: false });
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    fs.unwatchFile(this.notificationsFile, this.notificationFileListener);
    fs.unwatchFile(this.eventsFile, this.eventFileListener);
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
    const result = this.store.markSessionRead(sessionName, eventSource);
    this.reloadNow({ emit: true, reason: 'mark-session-read' });
    return result;
  }

  markTargetSessionRead(sessionName: string, eventSource: HydraEventSource = 'extension'): NotificationMarkSessionReadResult {
    const unread = this.store.list({ targetSession: sessionName, unread: true }).notifications;
    const notifications: HydraNotification[] = [];
    for (const notification of unread) {
      const result = this.store.markRead(notification.id, eventSource);
      if (result.markedRead > 0) {
        notifications.push(result.notification);
      }
    }
    this.reloadNow({ emit: true, reason: 'mark-target-session-read' });
    return {
      notifications,
      markedRead: notifications.length,
    };
  }

  clear(
    filters: Pick<NotificationListFilters, 'session' | 'targetSession' | 'sourceSession'> = {},
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

  private startWatching(): void {
    fs.watchFile(this.notificationsFile, { interval: this.pollIntervalMs }, this.notificationFileListener);
    fs.watchFile(this.eventsFile, { interval: this.pollIntervalMs }, this.eventFileListener);
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

    this.lastEventSeq = Math.max(after, ...events.map(event => event.seq));
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
    const storedNotificationIds = new Set<string>();

    for (const notification of notifications) {
      storedNotificationIds.add(notification.id);
      if (!notification.sourceSession || notification.targetSession === notification.sourceSession) {
        continue;
      }
      upsertLatestAttention(attention, notification.sourceSession, notification);
      if (notification.kind === 'complete') {
        upsertLatestCompletion(completions, notification.sourceSession, notification);
      }
    }

    let events: HydraEvent[];
    try {
      events = this.eventLog.read({ tolerateIncompleteTail: true });
    } catch (error) {
      logger.warn('notification-state.events', 'Failed to rebuild source notification projections', { error });
      this.sourceAttentionBySession = attention;
      this.sourceCompletionBySession = completions;
      return;
    }

    const eventOnlyNotifications = new Map<string, HydraNotification>();
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      const notification = notificationFromCreatedEvent(event);
      if (notification?.sourceSession) {
        if (!storedNotificationIds.has(notification.id)) {
          eventOnlyNotifications.set(notification.id, notification);
        }
        continue;
      }

      if (event.type !== 'notify.cleared') {
        continue;
      }

      for (const [id, projected] of eventOnlyNotifications.entries()) {
        if (notificationMatchesClearEvent(projected, event)) {
          eventOnlyNotifications.delete(id);
        }
      }
    }

    for (const notification of eventOnlyNotifications.values()) {
      if (!notification.sourceSession) {
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

function notificationFromCreatedEvent(event: HydraEvent): HydraNotification | undefined {
  if (event.type !== 'notify.created') {
    return undefined;
  }
  const payload = event.payload || {};
  if (!isNotificationKind(payload.kind)) {
    return undefined;
  }
  const sourceSession = getStringPayload(payload, 'sourceSession');
  const targetSession = getStringPayload(payload, 'targetSession');
  if (!sourceSession || targetSession === sourceSession) {
    return undefined;
  }
  const id = getStringPayload(payload, 'notificationId') || `event:${event.seq}`;
  const action = getActionPayload(payload);
  return {
    id,
    createdAt: event.ts,
    readAt: null,
    kind: payload.kind,
    title: getStringPayload(payload, 'title') || getDefaultNotificationTitle(payload.kind),
    body: getStringPayload(payload, 'body') || '',
    targetSession: targetSession || null,
    sourceSession,
    action,
    context: {
      workerId: getNumberPayload(payload, 'workerId'),
      branch: getStringPayload(payload, 'branch') ?? null,
      workdir: getStringPayload(payload, 'workdir') ?? null,
      agent: getStringPayload(payload, 'agent') ?? null,
    },
  };
}

function notificationMatchesClearEvent(notification: HydraNotification, event: HydraEvent): boolean {
  const payload = event.payload || {};
  const session = getStringPayload(payload, 'session');
  const targetSession = getStringPayload(payload, 'targetSession');
  const sourceSession = getStringPayload(payload, 'sourceSession');

  if (!session && !targetSession && !sourceSession) {
    return true;
  }
  if (session && notification.targetSession !== session && notification.sourceSession !== session) {
    return false;
  }
  if (targetSession && notification.targetSession !== targetSession) {
    return false;
  }
  if (sourceSession && notification.sourceSession !== sourceSession) {
    return false;
  }
  return true;
}

const SOURCE_ATTENTION_KIND_PRIORITY: Record<NotificationKind, number> = {
  error: 0,
  blocked: 1,
  'needs-input': 2,
  complete: 3,
  info: 4,
};

function getDefaultNotificationTitle(kind: NotificationKind): string {
  switch (kind) {
    case 'complete':
      return 'Worker completed';
    case 'error':
      return 'Worker error';
    case 'blocked':
      return 'Worker blocked';
    case 'needs-input':
      return 'Worker needs input';
    case 'info':
      return 'Worker notification';
  }
}

function getActionPayload(payload: Record<string, unknown>): HydraNotification['action'] | undefined {
  const type = getStringPayload(payload, 'actionType');
  const session = getStringPayload(payload, 'actionSession');
  if ((type === 'open-session' || type === 'review-diff') && session) {
    return { type, session };
  }
  return undefined;
}

function getStringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value ? value : undefined;
}

function getNumberPayload(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
