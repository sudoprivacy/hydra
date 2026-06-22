import type { HydraNotification } from './notifications';

export interface NotificationSnapshot {
  readonly loadedAt: string;
  readonly lastEventSeq: number;
  readonly notifications: readonly HydraNotification[];
  readonly totalCount: number;
  readonly unreadCount: number;
}

export interface NotificationStateIndexes {
  readonly byId: ReadonlyMap<string, HydraNotification>;
  readonly bySession: ReadonlyMap<string, readonly HydraNotification[]>;
  readonly byTargetSession: ReadonlyMap<string, readonly HydraNotification[]>;
  readonly bySourceSession: ReadonlyMap<string, readonly HydraNotification[]>;
}

export interface NotificationState {
  readonly snapshot: NotificationSnapshot;
  readonly indexes: NotificationStateIndexes;
  readonly contentRevision: string;
}

export function buildNotificationState(
  notifications: readonly HydraNotification[],
  lastEventSeq: number,
  loadedAt: string = new Date().toISOString(),
): NotificationState {
  const clonedNotifications = notifications.map(cloneNotification);
  return {
    snapshot: {
      loadedAt,
      lastEventSeq,
      notifications: clonedNotifications,
      totalCount: clonedNotifications.length,
      unreadCount: clonedNotifications.filter(notification => notification.readAt === null).length,
    },
    indexes: buildIndexes(clonedNotifications),
    contentRevision: buildContentRevision(clonedNotifications),
  };
}

export function cloneNotification(notification: HydraNotification): HydraNotification {
  const cloned: HydraNotification = {
    id: notification.id,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    targetSession: notification.targetSession,
    sourceSession: notification.sourceSession,
  };
  if (notification.dedupeKey !== undefined) {
    cloned.dedupeKey = notification.dedupeKey;
  }
  if (notification.action) {
    cloned.action = { ...notification.action };
  }
  if (notification.context) {
    cloned.context = { ...notification.context };
  }
  return cloned;
}

export function cloneSnapshot(snapshot: NotificationSnapshot): NotificationSnapshot {
  return {
    loadedAt: snapshot.loadedAt,
    lastEventSeq: snapshot.lastEventSeq,
    notifications: snapshot.notifications.map(cloneNotification),
    totalCount: snapshot.totalCount,
    unreadCount: snapshot.unreadCount,
  };
}

export function getLatestNotifications(snapshot: NotificationSnapshot, limit?: number): HydraNotification[] {
  const notifications = snapshot.notifications.map(cloneNotification);
  if (limit == null) {
    return notifications;
  }
  return notifications.slice(0, Math.max(0, Math.trunc(limit)));
}

function buildIndexes(notifications: readonly HydraNotification[]): NotificationStateIndexes {
  const byId = new Map<string, HydraNotification>();
  const bySession = new Map<string, HydraNotification[]>();
  const byTargetSession = new Map<string, HydraNotification[]>();
  const bySourceSession = new Map<string, HydraNotification[]>();

  for (const notification of notifications) {
    byId.set(notification.id, notification);
    const sessions = new Set<string>();
    if (notification.targetSession) {
      sessions.add(notification.targetSession);
      addToIndex(byTargetSession, notification.targetSession, notification);
    }
    if (notification.sourceSession) {
      sessions.add(notification.sourceSession);
      addToIndex(bySourceSession, notification.sourceSession, notification);
    }
    for (const session of sessions) {
      addToIndex(bySession, session, notification);
    }
  }

  return { byId, bySession, byTargetSession, bySourceSession };
}

function addToIndex(
  index: Map<string, HydraNotification[]>,
  sessionName: string,
  notification: HydraNotification,
): void {
  const existing = index.get(sessionName);
  if (existing) {
    existing.push(notification);
  } else {
    index.set(sessionName, [notification]);
  }
}

function buildContentRevision(notifications: readonly HydraNotification[]): string {
  return JSON.stringify(notifications.map(notification => ({
    id: notification.id,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    targetSession: notification.targetSession,
    sourceSession: notification.sourceSession,
    dedupeKey: notification.dedupeKey,
    action: notification.action ? {
      type: notification.action.type,
      session: notification.action.session,
    } : null,
    context: notification.context ? {
      workerId: notification.context.workerId,
      branch: notification.context.branch,
      workdir: notification.context.workdir,
      agent: notification.context.agent,
    } : null,
  })));
}
