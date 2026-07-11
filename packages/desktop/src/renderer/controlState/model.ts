import type {
  GitChangeStatus,
  HydraNotificationV2,
  HydraSessionList,
  WorkerRuntimeSnapshotV2,
} from '@hydra/protocol';

/**
 * Renderer-owned control-plane state.
 *
 * Domain collections are keyed by durable identities. Session names remain
 * route/display aliases and may change without losing Worker runtime or
 * attention state.
 */
export interface DesktopControlModel {
  readonly sessions: HydraSessionList;
  readonly runtimeByWorkerId: ReadonlyMap<number, WorkerRuntimeSnapshotV2>;
  readonly runtimeEventSeqByWorkerId: ReadonlyMap<number, number>;
  readonly occurrencesById: ReadonlyMap<string, HydraNotificationV2>;
  readonly gitStatusBySession: Readonly<Record<string, GitChangeStatus>>;
  readonly lastEventSeq: number;
  readonly runtimeLastEventSeq: number;
  readonly attentionLastEventSeq: number;
  readonly sessionsConnected: boolean;
  readonly attentionConnected: boolean;
}

export const EMPTY_SESSION_LIST: HydraSessionList = {
  copilots: [],
  workers: [],
  count: 0,
};
