import type { NotificationListFilters } from './notifications';

export interface SessionNotificationScopeItem {
  contextValue?: string;
}

export interface SessionNotificationClearScope {
  filters: Pick<NotificationListFilters, 'session' | 'targetSession' | 'sourceSession'>;
  lookup: 'session' | 'targetSession';
}

const WORKER_CONTEXT_VALUES = new Set([
  'workerItem',
  'inactiveWorkerItem',
  'taskWorkerItem',
  'inactiveTaskWorkerItem',
]);

export function resolveSessionNotificationClearScope(
  item: SessionNotificationScopeItem | undefined,
  sessionName: string,
): SessionNotificationClearScope {
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
