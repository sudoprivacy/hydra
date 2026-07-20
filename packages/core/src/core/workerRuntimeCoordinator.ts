import { randomUUID } from 'crypto';
import { EventLog, type HydraEventSource } from './events';
import { logger } from './logger';
import type { HydraNotification } from './notifications';
import type {
  SetWorkerRuntimeStateInput,
  SetWorkerRuntimeStateResult,
  WorkerRuntimeSignalOrigin,
  WorkerRuntimeSnapshot,
  WorkerRuntimeState,
} from './workerRuntimeState';
import {
  WorkerRuntimeStateStoreV2,
  validateWorkerRuntimeSignalV2,
  type WorkerRuntimeSignalOriginV2,
  type WorkerRuntimeSignalV2,
  type WorkerRuntimeSnapshotV2,
} from './workerRuntimeV2';

export type WorkerRuntimeApplyOutcome = 'applied' | 'duplicate' | 'stale-revision' | 'stale-run' | 'stale-epoch' | 'illegal-transition' | 'worker-not-found';

export interface WorkerRuntimeApplyResult {
  outcome: WorkerRuntimeApplyOutcome;
  snapshot?: WorkerRuntimeSnapshotV2;
  previous?: WorkerRuntimeSnapshotV2;
}

export interface WorkerRuntimeIdentity {
  workerId: number;
  sessionName: string;
  lifecycleEpoch: string;
  agent?: string | null;
  workdir?: string | null;
}

export type WorkerRuntimeIdentityResolver = (workerId: number) => WorkerRuntimeIdentity | undefined;

export interface WorkerRuntimeV1ProjectionStore {
  get(sessionName: string): WorkerRuntimeSnapshot | undefined;
  project(input: SetWorkerRuntimeStateInput): SetWorkerRuntimeStateResult;
  set(input: SetWorkerRuntimeStateInput, eventSource?: HydraEventSource): SetWorkerRuntimeStateResult;
  clear(sessionName: string): boolean;
}

export class WorkerRuntimeCoordinator {
  constructor(
    private readonly resolveWorker: WorkerRuntimeIdentityResolver,
    private readonly store: WorkerRuntimeStateStoreV2 = new WorkerRuntimeStateStoreV2(),
    private readonly compatibilityStore: WorkerRuntimeV1ProjectionStore,
    private readonly eventLog: EventLog = new EventLog(),
  ) {}

  apply(signal: WorkerRuntimeSignalV2, eventSource: HydraEventSource = 'extension'): WorkerRuntimeApplyResult {
    validateWorkerRuntimeSignalV2(signal);
    const worker = this.resolveWorker(signal.workerId);
    if (!worker) return this.reject('worker-not-found', signal);
    validateIdentity(worker, signal.workerId);
    if (worker.lifecycleEpoch !== signal.lifecycleEpoch) return this.reject('stale-epoch', signal);

    const result = this.store.update(store => {
      const key = String(signal.workerId);
      const previous = store.workers[key];
      if (WorkerRuntimeStateStoreV2.hasProcessedSignal(store, signal.workerId, signal.lifecycleEpoch, signal.signalId)) {
        return resultFor('duplicate', previous, previous);
      }

      const currentEpochSnapshot = previous?.lifecycleEpoch === signal.lifecycleEpoch ? previous : undefined;
      const rejection = validateCurrentEpochSignal(currentEpochSnapshot, signal);
      if (rejection) {
        WorkerRuntimeStateStoreV2.rememberSignal(
          store,
          signal.workerId,
          signal.lifecycleEpoch,
          signal.signalId,
        );
        return resultFor(rejection, previous, previous);
      }

      const snapshot = createSnapshot(signal, worker, currentEpochSnapshot);
      store.workers[key] = snapshot;
      if (previous && previous.sessionName !== snapshot.sessionName) {
        store.pendingCompatibilityClears[key] = Array.from(new Set([
          ...(store.pendingCompatibilityClears[key] ?? []),
          previous.sessionName,
        ]));
      }
      WorkerRuntimeStateStoreV2.rememberSignal(
        store,
        signal.workerId,
        signal.lifecycleEpoch,
        signal.signalId,
      );
      return resultFor('applied', snapshot, previous);
    });

    if (result.outcome !== 'applied' || !result.snapshot) {
      const rejected = this.reject(
        result.outcome as Exclude<WorkerRuntimeApplyOutcome, 'applied'>,
        signal,
        result.snapshot,
        result.previous,
      );
      if (result.outcome === 'duplicate' && result.snapshot) {
        this.reconcileCompatibility(result.snapshot.workerId);
      }
      return rejected;
    }

    this.emitChanged(result.snapshot, result.previous, eventSource);
    this.reconcileCompatibility(result.snapshot.workerId);
    return result;
  }

  clear(workerId: number): boolean {
    const snapshot = this.store.get(workerId);
    const identity = this.resolveWorker(workerId);
    const routes = new Set(this.store.getPendingCompatibilityClears(workerId));
    if (snapshot) routes.add(snapshot.sessionName);
    if (identity) routes.add(identity.sessionName);
    for (const sessionName of routes) {
      this.compatibilityStore.clear(sessionName);
    }
    return this.store.clear(workerId);
  }

  projectCompatibilitySnapshot(snapshot: WorkerRuntimeSnapshotV2): SetWorkerRuntimeStateResult {
    return this.projectV1(snapshot);
  }

  private projectV1(snapshot: WorkerRuntimeSnapshotV2): SetWorkerRuntimeStateResult {
    return this.compatibilityStore.project(toCompatibilityInput(snapshot));
  }

  private reconcileCompatibility(workerId: number): void {
    while (true) {
      const pendingClears = this.store.getPendingCompatibilityClears(workerId);
      const clearedSessionNames: string[] = [];
      for (const sessionName of pendingClears) {
        this.compatibilityStore.clear(sessionName);
        clearedSessionNames.push(sessionName);
      }

      const authoritative = this.store.get(workerId);
      if (!authoritative) return;
      this.projectV1(authoritative);
      this.store.acknowledgeCompatibilityClears(workerId, clearedSessionNames);

      const current = this.store.get(workerId);
      const remainingClears = this.store.getPendingCompatibilityClears(workerId);
      if (current
        && current.lifecycleEpoch === authoritative.lifecycleEpoch
        && current.signalId === authoritative.signalId
        && current.revision === authoritative.revision
        && current.sessionName === authoritative.sessionName
        && remainingClears.length === 0) {
        return;
      }
    }
  }

  private emitChanged(snapshot: WorkerRuntimeSnapshotV2, previous: WorkerRuntimeSnapshotV2 | undefined, source: HydraEventSource): void {
    try {
      this.eventLog.append({
        type: 'worker.runtime.changed', source, session: snapshot.sessionName, role: 'worker', agent: snapshot.agent, workdir: snapshot.workdir,
        payload: {
          state: snapshot.state, previousState: previous?.state, origin: snapshot.origin, reason: snapshot.reason,
          notificationId: snapshot.occurrenceId, occurrenceId: snapshot.occurrenceId, workerId: snapshot.workerId,
          lifecycleEpoch: snapshot.lifecycleEpoch, runId: snapshot.runId, revision: snapshot.revision,
          signalId: snapshot.signalId, sourceSequence: snapshot.sourceSequence,
          updatedAt: snapshot.observedAt, observedAt: snapshot.observedAt,
        },
      });
    } catch (error) {
      logger.warn('worker-runtime-coordinator.event', 'Failed to append worker runtime event', { workerId: snapshot.workerId, signalId: snapshot.signalId, error });
    }
  }

  private reject(outcome: Exclude<WorkerRuntimeApplyOutcome, 'applied'>, signal: WorkerRuntimeSignalV2, snapshot?: WorkerRuntimeSnapshotV2, previous?: WorkerRuntimeSnapshotV2): WorkerRuntimeApplyResult {
    logger.warn('worker-runtime-coordinator.rejected', 'Rejected worker runtime signal', {
      outcome, workerId: signal.workerId, sessionName: signal.sessionName, lifecycleEpoch: signal.lifecycleEpoch,
      runId: signal.runId, revision: signal.revision, signalId: signal.signalId,
    });
    return { outcome, snapshot, previous };
  }
}

export function applyLegacyWorkerRuntimeState(
  input: SetWorkerRuntimeStateInput,
  eventSource: HydraEventSource,
  compatibilityStore: WorkerRuntimeV1ProjectionStore,
  storeV2 = new WorkerRuntimeStateStoreV2(),
): SetWorkerRuntimeStateResult {
  // Release-N compatibility identity: until stable lifecycle identity migrates,
  // legacy producers share a deterministic epoch per numeric workerId.
  if (typeof input.workerId !== 'number') return compatibilityStore.set(input, eventSource);
  const previous = storeV2.get(input.workerId);
  const lifecycleEpoch = input.lifecycleEpoch ?? previous?.lifecycleEpoch ?? `legacy-worker-${input.workerId}`;
  const coordinator = new WorkerRuntimeCoordinator(
    workerId => workerId === input.workerId ? {
      workerId, sessionName: input.sessionName, lifecycleEpoch, agent: input.agent, workdir: input.workdir,
    } : undefined,
    storeV2,
    compatibilityStore,
  );

  if (!previous && input.state === 'needs-input') {
    const runId = input.runId ?? randomUUID();
    coordinator.apply({
      workerId: input.workerId,
      sessionName: input.sessionName,
      lifecycleEpoch,
      runId,
      revision: 0,
      state: 'running',
      signalId: randomUUID(),
      origin: 'manual',
      reason: 'legacy-run-bootstrap',
      observedAt: input.updatedAt ?? new Date().toISOString(),
      agent: input.agent,
      workdir: input.workdir,
    }, eventSource);
  }

  const current = storeV2.get(input.workerId);
  const result = coordinator.apply({
    workerId: input.workerId,
    sessionName: input.sessionName,
    lifecycleEpoch,
    runId: resolveRunId(current, input.state, input.runId),
    revision: input.revision ?? ((current?.revision ?? -1) + 1),
    state: input.state,
    signalId: input.signalId ?? randomUUID(),
    occurrenceId: input.occurrenceId ?? input.notificationId,
    sourceSequence: input.sourceSequence,
    origin: mapOrigin(input.origin),
    reason: input.reason ?? input.state,
    observedAt: input.updatedAt ?? new Date().toISOString(),
    agent: input.agent,
    workdir: input.workdir,
  }, eventSource);

  if (result.outcome === 'applied' && result.snapshot) {
    return {
      snapshot: compatibilityStore.get(result.snapshot.sessionName) ?? coordinator.projectCompatibilitySnapshot(result.snapshot).snapshot,
      changed: true,
    };
  }

  const authoritative = result.snapshot ?? result.previous;
  if (authoritative) {
    if (authoritative.sessionName !== input.sessionName) compatibilityStore.clear(input.sessionName);
    const projected = coordinator.projectCompatibilitySnapshot(authoritative);
    return { snapshot: projected.snapshot, changed: false };
  }

  const existing = compatibilityStore.get(input.sessionName);
  if (existing) return { snapshot: existing, changed: false };
  throw new Error(`Worker runtime signal was rejected with ${result.outcome} and no authoritative snapshot exists`);
}

export function projectLegacyNotificationRuntime(
  notification: HydraNotification,
  eventSource: HydraEventSource,
  compatibilityStore: WorkerRuntimeV1ProjectionStore,
  occurrence?: Pick<WorkerRuntimeSignalV2, 'lifecycleEpoch' | 'runId'>,
): SetWorkerRuntimeStateResult | undefined {
  if (!notification.sourceSession || typeof notification.context?.workerId !== 'number') return undefined;
  const state = notification.kind === 'complete' ? 'idle'
    : notification.kind === 'needs-input' ? 'needs-input'
      : notification.kind === 'error' ? 'error'
        : undefined;
  if (!state) return undefined;
  return applyLegacyWorkerRuntimeState({
    sessionName: notification.sourceSession,
    state,
    origin: 'notification',
    reason: notification.kind,
    notificationId: notification.id,
    occurrenceId: notification.id,
    workerId: notification.context.workerId,
    lifecycleEpoch: occurrence?.lifecycleEpoch,
    runId: occurrence?.runId,
    agent: notification.context.agent,
    workdir: notification.context.workdir,
    updatedAt: notification.createdAt,
  }, eventSource, compatibilityStore);
}

function validateIdentity(identity: WorkerRuntimeIdentity, workerId: number): void {
  if (identity.workerId !== workerId) throw new Error('Worker runtime identity resolver returned a mismatched workerId');
  validateWorkerRuntimeSignalV2({
    workerId: identity.workerId,
    sessionName: identity.sessionName,
    lifecycleEpoch: identity.lifecycleEpoch,
    runId: null,
    revision: 0,
    state: 'idle',
    signalId: 'identity-validation',
    origin: 'manual',
    reason: 'identity-validation',
    observedAt: new Date(0).toISOString(),
    agent: identity.agent,
    workdir: identity.workdir,
  });
}

function validateCurrentEpochSignal(
  previous: WorkerRuntimeSnapshotV2 | undefined,
  signal: WorkerRuntimeSignalV2,
): Exclude<WorkerRuntimeApplyOutcome, 'applied' | 'duplicate' | 'stale-epoch' | 'worker-not-found'> | undefined {
  if (!hasValidRunIdentity(previous, signal)) return 'stale-run';
  if (previous && signal.revision <= previous.revision) return 'stale-revision';
  if (previous?.sourceSequence !== undefined && signal.sourceSequence !== undefined && signal.sourceSequence < previous.sourceSequence) {
    return 'stale-revision';
  }
  if (previous) {
    if (!isLegalTransition(previous.state, signal, true)) return 'illegal-transition';
  } else if (!isLegalTransition('unknown', signal, false)) {
    return 'illegal-transition';
  }
  return undefined;
}

function hasValidRunIdentity(previous: WorkerRuntimeSnapshotV2 | undefined, signal: WorkerRuntimeSignalV2): boolean {
  if ((signal.state === 'running' || signal.state === 'needs-input') && signal.runId === null) return false;
  if (!previous) return true;

  const activeRun = previous.state === 'running' || previous.state === 'needs-input';
  if (activeRun) {
    return signal.runId === previous.runId;
  }
  if (signal.state === 'running') {
    return signal.runId !== null && signal.runId !== previous.runId;
  }
  if ((signal.state === 'idle' || signal.state === 'error') && signal.runId !== null) {
    return signal.runId === previous.runId;
  }
  return true;
}

function resultFor(outcome: WorkerRuntimeApplyOutcome, snapshot?: WorkerRuntimeSnapshotV2, previous?: WorkerRuntimeSnapshotV2): WorkerRuntimeApplyResult {
  return { outcome, snapshot: snapshot && { ...snapshot }, previous: previous && { ...previous } };
}

function createSnapshot(
  signal: WorkerRuntimeSignalV2,
  worker: WorkerRuntimeIdentity,
  previous: WorkerRuntimeSnapshotV2 | undefined,
): WorkerRuntimeSnapshotV2 {
  return {
    version: 2,
    ...signal,
    sessionName: worker.sessionName,
    sourceSequence: signal.sourceSequence ?? previous?.sourceSequence,
    agent: worker.agent ?? signal.agent ?? null,
    workdir: worker.workdir ?? signal.workdir ?? null,
  };
}

function isLegalTransition(
  from: WorkerRuntimeState,
  signal: WorkerRuntimeSignalV2,
  allowSameState: boolean,
): boolean {
  const to = signal.state;
  if (!allowSameState && from === 'unknown' && to === 'unknown') {
    return isGuardedInitialUnknown(signal);
  }
  if (allowSameState && from === to) {
    return to !== 'unknown' || isGuardedUnknownSignal(signal);
  }
  if (to === 'unknown') {
    return (from === 'idle' || from === 'running' || from === 'needs-input')
      && isGuardedUnknownSignal(signal);
  }
  switch (from) {
    case 'unknown': return to === 'running' || to === 'idle' || to === 'error';
    case 'running': return to === 'needs-input' || to === 'idle' || to === 'error';
    case 'needs-input': return to === 'running' || to === 'idle' || to === 'error';
    case 'idle': return to === 'running' || to === 'error';
    case 'error': return to === 'running' || to === 'idle';
  }
}

function isGuardedInitialUnknown(signal: WorkerRuntimeSignalV2): boolean {
  if (signal.origin !== 'lifecycle') return false;
  if (signal.reason === 'completion-tracking-unavailable') {
    return signal.runId !== null;
  }
  return signal.runId === null
    && (signal.reason === 'worker-creating'
      || signal.reason === 'worker-starting'
      || signal.reason === 'worker-restoring');
}

function isGuardedUnknownSignal(signal: WorkerRuntimeSignalV2): boolean {
  return signal.origin === 'lifecycle'
    && (signal.reason === 'completion-tracking-unavailable'
      || signal.reason === 'worker-renamed'
      || signal.reason === 'worker-creating'
      || signal.reason === 'worker-starting'
      || signal.reason === 'worker-restoring');
}

function resolveRunId(previous: WorkerRuntimeSnapshotV2 | undefined, state: WorkerRuntimeState, requested: string | null | undefined): string | null {
  if (requested !== undefined) return requested;
  if (state === 'running') {
    return previous && (previous.state === 'running' || previous.state === 'needs-input')
      ? previous.runId ?? randomUUID()
      : randomUUID();
  }
  if (state === 'needs-input') return previous?.runId ?? randomUUID();
  return previous?.runId ?? null;
}

function mapOrigin(origin: WorkerRuntimeSignalOrigin): WorkerRuntimeSignalOriginV2 {
  if (origin === 'session-manager') return 'lifecycle';
  if (origin === 'notification') return 'manual';
  return origin;
}

function toCompatibilityInput(snapshot: WorkerRuntimeSnapshotV2): SetWorkerRuntimeStateInput {
  return {
    sessionName: snapshot.sessionName,
    state: snapshot.state,
    origin: snapshot.origin === 'lifecycle' ? 'session-manager' : snapshot.origin,
    reason: snapshot.reason,
    notificationId: snapshot.occurrenceId,
    workerId: snapshot.workerId,
    agent: snapshot.agent,
    workdir: snapshot.workdir,
    updatedAt: snapshot.observedAt,
  };
}
