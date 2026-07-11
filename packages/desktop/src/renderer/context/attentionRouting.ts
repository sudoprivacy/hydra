import type { HydraNotificationV2 } from '@hydra/protocol';

import type { WorkerControlRow } from '../controlState/selectors';
import type { TabView } from '../tabs/TabsProvider';

export interface AttentionRouteDecision {
  readonly session: string | null;
  readonly workerId?: number;
  readonly agentSessionId?: string | null;
  readonly view: TabView;
  readonly markReadId: string | null;
}

export function resolveAttentionRoute(
  occurrence: HydraNotificationV2,
  worker: WorkerControlRow | null,
): AttentionRouteDecision {
  return {
    session: worker?.session ?? null,
    workerId: worker?.workerId,
    agentSessionId: worker?.raw.agentSessionId,
    view: occurrence.kind === 'complete' && worker?.type === 'code' ? 'diff' : 'terminal',
    markReadId: occurrence.readAt === null ? occurrence.id : null,
  };
}
