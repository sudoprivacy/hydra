import type { HydraNotification, NotificationKind } from './notifications';

export interface SessionNotificationSource {
  getBySession(sessionName: string): readonly HydraNotification[];
  getByTargetSession(sessionName: string): readonly HydraNotification[];
  getBySourceSession(sessionName: string): readonly HydraNotification[];
  getLatestSourceAttention?(sessionName: string): HydraNotification | undefined;
  getLatestSourceCompletion?(sessionName: string): HydraNotification | undefined;
}

export interface SessionNotificationSummary {
  readonly sessionName: string;
  readonly unreadCount: number;
  readonly attention: HydraNotification;
  readonly kind: NotificationKind;
  readonly badge: string;
  readonly description: string;
}

const KIND_PRIORITY: Record<NotificationKind, number> = {
  error: 0,
  blocked: 1,
  'needs-input': 2,
  complete: 3,
  info: 4,
};

const KIND_BADGE: Record<NotificationKind, string> = {
  error: 'E',
  blocked: 'B',
  'needs-input': '?',
  complete: 'C',
  info: 'i',
};

const MAX_DESCRIPTION_TEXT_LENGTH = 72;

export function buildSessionNotificationSummary(
  sessionName: string,
  notifications: readonly HydraNotification[],
): SessionNotificationSummary | undefined {
  const unread = notifications
    .filter(notification => notification.readAt === null)
    .sort(compareAttentionNotifications);

  const attention = unread[0];
  if (!attention) {
    return undefined;
  }

  const text = truncateSummaryText(normalizeSummaryText(attention.title || attention.body));
  const unreadLabel = `${unread.length} unread`;
  const kind = attention.kind;
  return {
    sessionName,
    unreadCount: unread.length,
    attention,
    kind,
    badge: KIND_BADGE[kind],
    description: text ? `${unreadLabel} · ${kind}: ${text}` : `${unreadLabel} · ${kind}`,
  };
}

function compareAttentionNotifications(a: HydraNotification, b: HydraNotification): number {
  const priorityDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff !== 0) {
    return timeDiff;
  }

  return b.createdAt.localeCompare(a.createdAt);
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummaryText(value: string): string {
  if (value.length <= MAX_DESCRIPTION_TEXT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DESCRIPTION_TEXT_LENGTH - 3).trimEnd()}...`;
}
