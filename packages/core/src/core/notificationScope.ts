import type { NotificationListFilters } from './notifications';

export interface SessionNotificationScopeItem {
  contextValue?: string;
}

export interface SessionNotificationScope {
  filters: Pick<NotificationListFilters, 'session' | 'targetSession' | 'sourceSession'>;
  lookup: 'session' | 'targetSession';
}

/** @deprecated Use SessionNotificationScope for all notification operations. */
export type SessionNotificationClearScope = SessionNotificationScope;

const WORKER_CONTEXT_VALUES = new Set([
  'workerItem',
  'inactiveWorkerItem',
  'taskWorkerItem',
  'inactiveTaskWorkerItem',
]);

export function resolveSessionNotificationScope(
  item: SessionNotificationScopeItem | undefined,
  sessionName: string,
): SessionNotificationScope {
  if (item?.contextValue && WORKER_CONTEXT_VALUES.has(item.contextValue)) {
    return {
      filters: { session: sessionName },
      lookup: 'session',
    };
  }

  return {
    filters: { targetSession: sessionName },
    lookup: 'targetSession',
  };
}

/** @deprecated Use resolveSessionNotificationScope for all notification operations. */
export const resolveSessionNotificationClearScope = resolveSessionNotificationScope;
