import type {
  HydraEvent,
  WorkerRuntimeSnapshotV2,
  WorkerRuntimeState,
} from '@hydra/protocol';

import type { DesktopControlModel } from './model';

type WorkerRuntimeSignalOriginV2 = WorkerRuntimeSnapshotV2['origin'];

const MEMBERSHIP_EVENTS = new Set([
  'worker.created',
  'worker.deleted',
  'worker.restored',
  'copilot.created',
  'copilot.deleted',
  'copilot.restored',
]);

const SESSION_REFRESH_EVENTS = new Set([
  ...MEMBERSHIP_EVENTS,
  'worker.started',
  'worker.stopped',
  'copilot.started',
]);

const RUNTIME_STATES = new Set<WorkerRuntimeState>([
  'unknown',
  'running',
  'idle',
  'needs-input',
  'error',
]);

const RUNTIME_ORIGINS = new Set<WorkerRuntimeSignalOriginV2>([
  'lifecycle',
  'hook',
  'codex-transcript',
  'manual',
]);

export type RuntimeEventAdaptResult =
  | { readonly kind: 'apply'; readonly snapshot: WorkerRuntimeSnapshotV2 }
  | { readonly kind: 'ignore'; readonly reason: string }
  | { readonly kind: 'refresh'; readonly reason: string };

export function isMembershipEvent(type: string): boolean {
  return MEMBERSHIP_EVENTS.has(type);
}

export function isSessionRefreshEvent(type: string): boolean {
  return SESSION_REFRESH_EVENTS.has(type);
}

/**
 * Convert a redaction-safe `worker.runtime.changed` event into the full v2
 * runtime snapshot shape. Malformed/identity-mismatched events request an
 * authoritative refresh; stale revisions/runs are harmlessly ignored.
 */
export function adaptRuntimeEvent(
  model: DesktopControlModel,
  event: HydraEvent,
): RuntimeEventAdaptResult {
  if (event.type !== 'worker.runtime.changed') {
    return { kind: 'ignore', reason: 'not a runtime event' };
  }
  const payload = event.payload;
  if (!isRecord(payload) || !readRequiredString(event.session)) {
    return { kind: 'refresh', reason: 'runtime event is missing its session or payload' };
  }

  const workerId = payload.workerId;
  if (!isPositiveSafeInteger(workerId)) {
    return { kind: 'refresh', reason: 'runtime event has an invalid workerId' };
  }
  const worker = model.sessions.workers.find(item => item.number === workerId);
  if (!worker || worker.session !== event.session) {
    return { kind: 'refresh', reason: 'runtime event route does not match current Worker identity' };
  }

  const state = payload.state;
  const origin = payload.origin;
  const lifecycleEpoch = readRequiredString(payload.lifecycleEpoch);
  const signalId = readRequiredString(payload.signalId);
  const reason = readRequiredString(payload.reason);
  const observedAt = readTimestamp(payload.observedAt)
    ?? readTimestamp(payload.updatedAt)
    ?? readTimestamp(event.ts);
  const revision = payload.revision;
  const runId = readNullableString(payload.runId);

  if (typeof state !== 'string' || !RUNTIME_STATES.has(state as WorkerRuntimeState)
    || typeof origin !== 'string' || !RUNTIME_ORIGINS.has(origin as WorkerRuntimeSignalOriginV2)
    || lifecycleEpoch === null
    || signalId === null
    || reason === null
    || observedAt === null
    || !isNonNegativeSafeInteger(revision)
    || runId === undefined) {
    return { kind: 'refresh', reason: 'runtime event is missing required v2 identity fields' };
  }
  if ((state === 'running' || state === 'needs-input') && runId === null) {
    return { kind: 'refresh', reason: 'active runtime event is missing runId' };
  }

  const occurrenceId = readOptionalString(payload.occurrenceId);
  const sourceSequence = payload.sourceSequence;
  if (occurrenceId === null
    || (sourceSequence !== undefined && !isNonNegativeSafeInteger(sourceSequence))) {
    return { kind: 'refresh', reason: 'runtime event has invalid optional v2 identity fields' };
  }

  const current = model.runtimeByWorkerId.get(workerId);
  if (!current) {
    return { kind: 'refresh', reason: 'runtime event has no authoritative baseline' };
  }
  if (current.lifecycleEpoch !== lifecycleEpoch) {
    return { kind: 'refresh', reason: 'runtime event lifecycle epoch differs from the baseline' };
  }
  if (revision <= current.revision) {
    return { kind: 'ignore', reason: 'stale runtime revision' };
  }
  if (current.sourceSequence !== undefined
    && sourceSequence !== undefined
    && sourceSequence < current.sourceSequence) {
    return { kind: 'ignore', reason: 'stale runtime source sequence' };
  }
  if (!matchesCurrentRun(current, state as WorkerRuntimeState, runId)) {
    return { kind: 'ignore', reason: 'stale runtime run' };
  }
  if (!isLegalRuntimeTransition(current.state, state as WorkerRuntimeState)) {
    return { kind: 'refresh', reason: 'runtime event contains an illegal state transition' };
  }

  const snapshot: WorkerRuntimeSnapshotV2 = {
    version: 2,
    workerId,
    sessionName: event.session,
    lifecycleEpoch,
    runId,
    revision,
    state: state as WorkerRuntimeState,
    signalId,
    origin: origin as WorkerRuntimeSignalOriginV2,
    reason,
    observedAt,
    agent: event.agent ?? current.agent ?? null,
    workdir: event.workdir ?? current.workdir ?? null,
  };
  if (occurrenceId !== undefined) snapshot.occurrenceId = occurrenceId;
  if (sourceSequence !== undefined) snapshot.sourceSequence = sourceSequence;
  return { kind: 'apply', snapshot };
}

export function isWorkerRuntimeSnapshotV2(value: unknown): value is WorkerRuntimeSnapshotV2 {
  if (!isRecord(value)
    || value.version !== 2
    || !isPositiveSafeInteger(value.workerId)
    || readRequiredString(value.sessionName) === null
    || readRequiredString(value.lifecycleEpoch) === null
    || !isNonNegativeSafeInteger(value.revision)
    || typeof value.state !== 'string'
    || !RUNTIME_STATES.has(value.state as WorkerRuntimeState)
    || readRequiredString(value.signalId) === null
    || typeof value.origin !== 'string'
    || !RUNTIME_ORIGINS.has(value.origin as WorkerRuntimeSignalOriginV2)
    || readRequiredString(value.reason) === null
    || readTimestamp(value.observedAt) === null) {
    return false;
  }
  const runId = readNullableString(value.runId);
  if (runId === undefined || ((value.state === 'running' || value.state === 'needs-input') && runId === null)) {
    return false;
  }
  return readOptionalString(value.occurrenceId) !== null
    && (value.sourceSequence === undefined || isNonNegativeSafeInteger(value.sourceSequence));
}

function matchesCurrentRun(
  current: WorkerRuntimeSnapshotV2,
  nextState: WorkerRuntimeState,
  nextRunId: string | null,
): boolean {
  const currentRunActive = current.state === 'running' || current.state === 'needs-input';
  if (currentRunActive) return nextRunId === current.runId;
  if (nextState === 'running') return nextRunId !== null && nextRunId !== current.runId;
  if (nextState === 'needs-input') return false;
  if ((nextState === 'idle' || nextState === 'error') && nextRunId !== null) {
    return nextRunId === current.runId;
  }
  return true;
}

function isLegalRuntimeTransition(from: WorkerRuntimeState, to: WorkerRuntimeState): boolean {
  if (from === to) return true;
  switch (from) {
    case 'unknown': return to === 'running' || to === 'idle' || to === 'error';
    case 'running': return to === 'needs-input' || to === 'idle' || to === 'error';
    case 'needs-input': return to === 'running' || to === 'idle' || to === 'error';
    case 'idle': return to === 'running' || to === 'error';
    case 'error': return to === 'running' || to === 'idle';
  }
}

function readRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return readRequiredString(value);
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readRequiredString(value) ?? undefined;
}

function readTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
