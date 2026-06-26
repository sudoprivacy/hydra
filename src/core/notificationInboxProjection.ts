import type { HydraNotification, NotificationKind } from './notifications';
import { cloneNotification, type NotificationSnapshot } from './notificationState';

export type NotificationInboxGroupSource = 'target' | 'source' | 'unassigned';

export interface NotificationInboxItem {
  readonly notification: HydraNotification;
  readonly groupId: string;
  readonly groupSession: string | null;
  readonly groupSource: NotificationInboxGroupSource;
  readonly priority: number;
}

export interface NotificationInboxGroup {
  readonly id: string;
  readonly sessionName: string | null;
  readonly source: NotificationInboxGroupSource;
  readonly unreadCount: number;
  readonly kind: NotificationKind;
  readonly latestCreatedAt: string;
  readonly items: readonly NotificationInboxItem[];
}

export interface NotificationInboxProjection {
  readonly loadedAt: string;
  readonly lastEventSeq: number;
  readonly unreadCount: number;
  readonly groups: readonly NotificationInboxGroup[];
  readonly items: readonly NotificationInboxItem[];
}

const KIND_PRIORITY: Record<NotificationKind, number> = {
  error: 0,
  blocked: 1,
  'needs-input': 2,
  complete: 3,
  info: 4,
};

export function buildNotificationInboxProjection(snapshot: NotificationSnapshot): NotificationInboxProjection {
  const items = snapshot.notifications
    .filter(notification => notification.readAt === null)
    .map(toInboxItem)
    .sort(compareInboxItems);

  const groupsById = new Map<string, NotificationInboxItem[]>();
  for (const item of items) {
    const group = groupsById.get(item.groupId);
    if (group) {
      group.push(item);
    } else {
      groupsById.set(item.groupId, [item]);
    }
  }

  const groups = [...groupsById.entries()]
    .map(([id, groupItems]): NotificationInboxGroup => {
      const sortedItems = [...groupItems].sort(compareInboxItems);
      const attention = sortedItems[0];
      return {
        id,
        sessionName: attention.groupSession,
        source: attention.groupSource,
        unreadCount: sortedItems.length,
        kind: attention.notification.kind,
        latestCreatedAt: sortedItems.reduce(
          (latest, item) => compareCreatedAtDescending(item.notification.createdAt, latest) < 0
            ? item.notification.createdAt
            : latest,
          sortedItems[0].notification.createdAt,
        ),
        items: sortedItems,
      };
    })
    .sort(compareInboxGroups);

  return {
    loadedAt: snapshot.loadedAt,
    lastEventSeq: snapshot.lastEventSeq,
    unreadCount: items.length,
    groups,
    items,
  };
}

export function compareInboxItems(a: NotificationInboxItem, b: NotificationInboxItem): number {
  const priorityDiff = a.priority - b.priority;
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const timeDiff = compareCreatedAtDescending(a.notification.createdAt, b.notification.createdAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return a.notification.id.localeCompare(b.notification.id);
}

function compareInboxGroups(a: NotificationInboxGroup, b: NotificationInboxGroup): number {
  const priorityDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const timeDiff = compareCreatedAtDescending(a.latestCreatedAt, b.latestCreatedAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return a.id.localeCompare(b.id);
}

function toInboxItem(notification: HydraNotification): NotificationInboxItem {
  const cloned = cloneNotification(notification);
  const targetSession = normalizeSession(cloned.targetSession);
  const sourceSession = normalizeSession(cloned.sourceSession);
  const groupSession = targetSession ?? sourceSession ?? null;
  const groupSource: NotificationInboxGroupSource = targetSession
    ? 'target'
    : sourceSession
      ? 'source'
      : 'unassigned';
  const groupId = groupSession
    ? `${groupSource}:${groupSession}`
    : 'unassigned';
  return {
    notification: cloned,
    groupId,
    groupSession,
    groupSource,
    priority: KIND_PRIORITY[cloned.kind],
  };
}

function normalizeSession(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compareCreatedAtDescending(a: string, b: string): number {
  const timeDiff = Date.parse(b) - Date.parse(a);
  if (Number.isFinite(timeDiff) && timeDiff !== 0) {
    return timeDiff;
  }
  return b.localeCompare(a);
}
