import type { NotificationClearFilters } from '@hydra/protocol';

export interface NotificationClearTile {
  readonly kind: 'worker' | 'copilot';
  readonly session: string;
}

export function completionNotificationClearFiltersForTile(tile: NotificationClearTile): NotificationClearFilters {
  return tile.kind === 'worker'
    ? completionNotificationClearFiltersForWorkerSession(tile.session)
    : { targetSession: tile.session, kind: 'complete' };
}

export function completionNotificationClearFiltersForWorkerSession(session: string): NotificationClearFilters {
  return { session, kind: 'complete' };
}
