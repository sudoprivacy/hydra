import type {
  GitStatusMap,
  HydraEvent,
  HydraNotificationV2,
  HydraSessionList,
  NotificationOccurrenceSnapshotV2,
  WorkerRuntimeListV2Result,
  WorkerRuntimeSnapshotV2,
} from '@hydra/protocol';

import {
  adaptRuntimeEvent,
  isSessionRefreshEvent,
  isWorkerRuntimeSnapshotV2,
} from './eventAdapters';
import type { DesktopControlModel } from './model';

export interface ApplyControlEventsResult {
  readonly model: DesktopControlModel;
  readonly sessionRefreshRequired: boolean;
  readonly runtimeRefreshRequired: boolean;
  readonly runtimeRefreshReasons: readonly string[];
}

export function createDesktopControlModel(
  sessions: HydraSessionList,
  runtime: WorkerRuntimeListV2Result,
): DesktopControlModel {
  const aliveWorkerIds = new Set(sessions.workers.map(worker => worker.number));
  const runtimeByWorkerId = new Map<number, WorkerRuntimeSnapshotV2>();
  const runtimeEventSeqByWorkerId = new Map<number, number>();
  for (const snapshot of runtime.runtimes) {
    if (!isWorkerRuntimeSnapshotV2(snapshot) || !aliveWorkerIds.has(snapshot.workerId)) continue;
    runtimeByWorkerId.set(snapshot.workerId, cloneRuntime(snapshot));
    runtimeEventSeqByWorkerId.set(snapshot.workerId, runtime.lastEventSeq);
  }
  return {
    sessions,
    runtimeByWorkerId,
    runtimeEventSeqByWorkerId,
    occurrencesById: new Map(),
    gitStatusBySession: {},
    lastEventSeq: runtime.lastEventSeq,
    runtimeLastEventSeq: runtime.lastEventSeq,
    attentionLastEventSeq: 0,
    sessionsConnected: false,
    attentionConnected: false,
  };
}

export function applySessionsSnapshot(
  model: DesktopControlModel,
  sessions: HydraSessionList,
): DesktopControlModel {
  const aliveWorkerIds = new Set(sessions.workers.map(worker => worker.number));
  const runtimeByWorkerId = filterMap(model.runtimeByWorkerId, workerId => aliveWorkerIds.has(workerId));
  const runtimeEventSeqByWorkerId = filterMap(
    model.runtimeEventSeqByWorkerId,
    workerId => aliveWorkerIds.has(workerId),
  );
  const liveCodeSessions = new Set(
    sessions.workers.filter(worker => worker.type === 'code').map(worker => worker.session),
  );
  const gitStatusBySession = Object.fromEntries(
    Object.entries(model.gitStatusBySession).filter(([session]) => liveCodeSessions.has(session)),
  );
  return {
    ...model,
    sessions,
    runtimeByWorkerId,
    runtimeEventSeqByWorkerId,
    gitStatusBySession,
  };
}

/**
 * Merge an authoritative runtime snapshot without rolling back an event that
 * was already applied after the snapshot's pre-read cursor.
 */
export function applyRuntimeSnapshot(
  model: DesktopControlModel,
  runtime: WorkerRuntimeListV2Result,
): DesktopControlModel {
  const aliveWorkerIds = new Set(model.sessions.workers.map(worker => worker.number));
  const incoming = new Map<number, WorkerRuntimeSnapshotV2>();
  for (const snapshot of runtime.runtimes) {
    if (!isWorkerRuntimeSnapshotV2(snapshot) || !aliveWorkerIds.has(snapshot.workerId)) continue;
    incoming.set(snapshot.workerId, cloneRuntime(snapshot));
  }

  const runtimeByWorkerId = new Map<number, WorkerRuntimeSnapshotV2>();
  const runtimeEventSeqByWorkerId = new Map<number, number>();
  for (const workerId of aliveWorkerIds) {
    const localEventSeq = model.runtimeEventSeqByWorkerId.get(workerId) ?? 0;
    const current = model.runtimeByWorkerId.get(workerId);
    if (current && localEventSeq > runtime.lastEventSeq) {
      runtimeByWorkerId.set(workerId, cloneRuntime(current));
      runtimeEventSeqByWorkerId.set(workerId, localEventSeq);
      continue;
    }
    const snapshot = incoming.get(workerId);
    if (current && !snapshot && localEventSeq >= runtime.lastEventSeq) {
      runtimeByWorkerId.set(workerId, cloneRuntime(current));
      runtimeEventSeqByWorkerId.set(workerId, localEventSeq);
      continue;
    }
    if (current
      && snapshot
      && current.lifecycleEpoch === snapshot.lifecycleEpoch
      && current.revision > snapshot.revision) {
      runtimeByWorkerId.set(workerId, cloneRuntime(current));
      runtimeEventSeqByWorkerId.set(workerId, Math.max(localEventSeq, runtime.lastEventSeq));
      continue;
    }
    if (snapshot) {
      runtimeByWorkerId.set(workerId, snapshot);
      runtimeEventSeqByWorkerId.set(workerId, runtime.lastEventSeq);
    }
  }

  return {
    ...model,
    runtimeByWorkerId,
    runtimeEventSeqByWorkerId,
    runtimeLastEventSeq: Math.max(model.runtimeLastEventSeq, runtime.lastEventSeq),
  };
}

export function applyNotificationOccurrenceSnapshot(
  model: DesktopControlModel,
  snapshot: NotificationOccurrenceSnapshotV2,
): DesktopControlModel {
  if (snapshot.lastEventSeq < model.attentionLastEventSeq) return model;
  const occurrencesById = new Map<string, HydraNotificationV2>();
  for (const occurrence of snapshot.occurrences) {
    if (!isUsableOccurrence(occurrence)) continue;
    occurrencesById.set(occurrence.id, cloneOccurrence(occurrence));
  }
  return {
    ...model,
    occurrencesById,
    attentionLastEventSeq: snapshot.lastEventSeq,
  };
}

export function applyGitStatus(
  model: DesktopControlModel,
  statuses: GitStatusMap,
): DesktopControlModel {
  const codeSessions = new Set(
    model.sessions.workers.filter(worker => worker.type === 'code').map(worker => worker.session),
  );
  const gitStatusBySession: GitStatusMap = {};
  for (const [session, status] of Object.entries(statuses)) {
    if (codeSessions.has(session)
      && Number.isSafeInteger(status.changed)
      && status.changed >= 0) {
      gitStatusBySession[session] = { changed: status.changed };
    }
  }
  return { ...model, gitStatusBySession };
}

export function applyConnectionState(
  model: DesktopControlModel,
  connection: Partial<Pick<DesktopControlModel, 'sessionsConnected' | 'attentionConnected'>>,
): DesktopControlModel {
  return { ...model, ...connection };
}

export function applyControlEvent(
  model: DesktopControlModel,
  event: HydraEvent,
): ApplyControlEventsResult {
  if (!Number.isSafeInteger(event.seq) || event.seq <= model.lastEventSeq) {
    return emptyEventResult(model);
  }

  let next: DesktopControlModel = {
    ...model,
    lastEventSeq: event.seq,
  };
  const sessionRefreshRequired = isSessionRefreshEvent(event.type);
  if (event.type !== 'worker.runtime.changed') {
    return {
      model: next,
      sessionRefreshRequired,
      runtimeRefreshRequired: false,
      runtimeRefreshReasons: [],
    };
  }

  const adapted = adaptRuntimeEvent(model, event);
  if (adapted.kind === 'apply') {
    const runtimeByWorkerId = new Map(model.runtimeByWorkerId);
    runtimeByWorkerId.set(adapted.snapshot.workerId, cloneRuntime(adapted.snapshot));
    const runtimeEventSeqByWorkerId = new Map(model.runtimeEventSeqByWorkerId);
    runtimeEventSeqByWorkerId.set(adapted.snapshot.workerId, event.seq);
    next = {
      ...next,
      runtimeByWorkerId,
      runtimeEventSeqByWorkerId,
      runtimeLastEventSeq: Math.max(model.runtimeLastEventSeq, event.seq),
    };
  }
  return {
    model: next,
    sessionRefreshRequired,
    runtimeRefreshRequired: adapted.kind === 'refresh',
    runtimeRefreshReasons: adapted.kind === 'refresh' ? [adapted.reason] : [],
  };
}

export function applyControlEvents(
  model: DesktopControlModel,
  events: readonly HydraEvent[],
): ApplyControlEventsResult {
  let next = model;
  let sessionRefreshRequired = false;
  let runtimeRefreshRequired = false;
  const runtimeRefreshReasons = new Set<string>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const result = applyControlEvent(next, event);
    next = result.model;
    sessionRefreshRequired ||= result.sessionRefreshRequired;
    runtimeRefreshRequired ||= result.runtimeRefreshRequired;
    for (const reason of result.runtimeRefreshReasons) runtimeRefreshReasons.add(reason);
  }
  return {
    model: next,
    sessionRefreshRequired,
    runtimeRefreshRequired,
    runtimeRefreshReasons: [...runtimeRefreshReasons],
  };
}

function emptyEventResult(model: DesktopControlModel): ApplyControlEventsResult {
  return {
    model,
    sessionRefreshRequired: false,
    runtimeRefreshRequired: false,
    runtimeRefreshReasons: [],
  };
}

function isUsableOccurrence(value: HydraNotificationV2): boolean {
  return value.version === 2
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.occurrenceId === 'string'
    && value.occurrenceId.length > 0
    && Number.isSafeInteger(value.workerId)
    && value.workerId > 0
    && value.status === 'active';
}

function cloneRuntime(snapshot: WorkerRuntimeSnapshotV2): WorkerRuntimeSnapshotV2 {
  return { ...snapshot };
}

function cloneOccurrence(occurrence: HydraNotificationV2): HydraNotificationV2 {
  return {
    ...occurrence,
    action: occurrence.action && { ...occurrence.action },
  };
}

function filterMap<K, V>(
  source: ReadonlyMap<K, V>,
  predicate: (key: K, value: V) => boolean,
): ReadonlyMap<K, V> {
  const result = new Map<K, V>();
  for (const [key, value] of source) {
    if (predicate(key, value)) result.set(key, value);
  }
  return result;
}
