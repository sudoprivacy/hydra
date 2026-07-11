import { type HydraEventSource } from './events';
import { hashText, redactText, truncateText } from './logRedaction';
import { logger } from './logger';
import {
  NotificationStore,
  type CreateNotificationResult,
  type HydraNotification,
  type NotificationKind,
} from './notifications';
import type { WorkerNeedsInputSignal } from './workerNeedsInputClassifier';
import type { WorkerInfo } from './sessionManager';
import { getWorkerLifecycleEpoch } from './workerIdentity';
import {
  setWorkerRuntimeState,
  WorkerRuntimeStateStore,
  type WorkerRuntimeSignalOrigin,
  type WorkerRuntimeState,
} from './workerRuntimeState';

export type WorkerRuntimeErrorReason =
  | 'post-create'
  | 'initial-prompt'
  | 'startup-timeout'
  | 'start'
  | 'message-delivery'
  | 'stop'
  | 'delete'
  | 'rename'
  | 'restore';

export interface PublishWorkerAttentionNotificationInput {
  kind: NotificationKind;
  targetCopilotSession?: string | null;
  sourceWorkerSession: string;
  title: string;
  body?: string;
  dedupeKey?: string;
  actionSession?: string;
  context?: HydraNotification['context'];
  eventSource?: HydraEventSource;
  store?: NotificationStore;
}

export interface PublishWorkerRuntimeErrorOptions {
  eventSource?: HydraEventSource;
  reason?: WorkerRuntimeErrorReason;
  store?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
}

export interface PublishWorkerNeedsInputOptions {
  eventSource?: HydraEventSource;
  store?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
}

export type PublishWorkerAttentionNotificationResult =
  | (CreateNotificationResult & { skipped?: undefined })
  | { created: false; notification?: undefined; skipped: 'store-failed' };

const ERROR_BODY_LIMIT = 600;
const NEEDS_INPUT_BODY_LIMIT = 600;

export function publishWorkerAttentionNotification(
  input: PublishWorkerAttentionNotificationInput,
): PublishWorkerAttentionNotificationResult {
  const targetCopilotSession = input.targetCopilotSession?.trim();

  try {
    return (input.store ?? new NotificationStore()).create({
      kind: input.kind,
      title: input.title,
      body: input.body,
      targetSession: targetCopilotSession || null,
      sourceSession: input.sourceWorkerSession,
      dedupeKey: input.dedupeKey,
      action: {
        type: 'open-session',
        session: input.actionSession || input.sourceWorkerSession,
      },
      context: input.context,
      eventSource: input.eventSource || 'session-manager',
    });
  } catch (error) {
    logger.warn('worker-attention-notification.create', 'Failed to create worker attention notification', {
      kind: input.kind,
      targetCopilotSession,
      sourceWorkerSession: input.sourceWorkerSession,
      error,
    });
    return { created: false, skipped: 'store-failed' };
  }
}

export function publishWorkerRuntimeErrorNotification(
  worker: WorkerInfo,
  error: unknown,
  options: PublishWorkerRuntimeErrorOptions = {},
): PublishWorkerAttentionNotificationResult {
  const reason = options.reason || classifyRuntimeErrorReason(error);
  const message = formatErrorMessage(error);
  const workerLabel = formatWorkerLabel(worker);
  const title = getWorkerRuntimeErrorTitle(workerLabel, reason);

  const result = publishWorkerAttentionNotification({
    kind: 'error',
    targetCopilotSession: worker.copilotSessionName,
    sourceWorkerSession: worker.sessionName,
    title,
    body: `${message}\n\nOpen the worker session to inspect the terminal output.`,
    dedupeKey: `worker-error:${worker.sessionName}:${reason}:${hashText(normalizeErrorSignature(message))}`,
    actionSession: worker.sessionName,
    context: {
      workerId: worker.workerId,
      branch: worker.branch,
      workdir: worker.workdir,
      agent: worker.agent,
    },
    eventSource: options.eventSource || 'session-manager',
    store: options.store,
  });
  if (result.created || result.skipped) {
    updateWorkerRuntimeStateFromAttention(
      worker,
      'error',
      reason,
      'session-manager',
      options.eventSource || 'session-manager',
      options.runtimeStateStore,
      'occurrence' in result ? result.occurrence : undefined,
    );
  }
  return result;
}

export function publishWorkerNeedsInputNotification(
  worker: WorkerInfo,
  signal: WorkerNeedsInputSignal,
  options: PublishWorkerNeedsInputOptions = {},
): PublishWorkerAttentionNotificationResult {
  const workerLabel = formatWorkerLabel(worker);
  const body = formatNeedsInputBody(signal);

  const result = publishWorkerAttentionNotification({
    kind: 'needs-input',
    targetCopilotSession: worker.copilotSessionName,
    sourceWorkerSession: worker.sessionName,
    title: `${workerLabel} needs input`,
    body,
    dedupeKey: `worker-needs-input:${worker.sessionName}:${signal.source}:${signal.reason}:${signal.fingerprint}`,
    actionSession: worker.sessionName,
    context: {
      workerId: worker.workerId,
      branch: worker.branch,
      workdir: worker.workdir,
      agent: worker.agent,
    },
    eventSource: options.eventSource || 'hook',
    store: options.store,
  });
  if (result.created || result.skipped) {
    updateWorkerRuntimeStateFromAttention(
      worker,
      'needs-input',
      signal.reason,
      signal.source === 'codex-transcript' ? 'codex-transcript' : 'hook',
      options.eventSource || 'hook',
      options.runtimeStateStore,
      'occurrence' in result ? result.occurrence : undefined,
    );
  }
  return result;
}

export async function awaitWorkerPostCreateOrPublishError(
  worker: WorkerInfo,
  postCreatePromise: Promise<void>,
  options: PublishWorkerRuntimeErrorOptions = {},
): Promise<void> {
  try {
    await postCreatePromise;
  } catch (error) {
    publishWorkerRuntimeErrorNotification(worker, error, options);
    throw error;
  }
}

export function classifyRuntimeErrorReason(error: unknown): WorkerRuntimeErrorReason {
  const message = formatErrorMessage(error);
  if (message.includes('Initial prompt delivery failed')) {
    return 'initial-prompt';
  }
  if (message.includes('Timed out waiting for worker startup')) {
    return 'startup-timeout';
  }
  return 'post-create';
}

function updateWorkerRuntimeStateFromAttention(
  worker: WorkerInfo,
  state: WorkerRuntimeState,
  reason: string,
  origin: WorkerRuntimeSignalOrigin,
  eventSource: HydraEventSource,
  runtimeStateStore?: WorkerRuntimeStateStore,
  occurrence?: CreateNotificationResult['occurrence'],
): void {
  try {
    setWorkerRuntimeState({
      sessionName: worker.sessionName,
      state,
      origin,
      reason,
      workerId: worker.workerId,
      occurrenceId: occurrence?.occurrenceId,
      lifecycleEpoch: occurrence?.lifecycleEpoch ?? getWorkerLifecycleEpoch(worker),
      runId: occurrence?.runId,
      agent: worker.agent,
      workdir: worker.workdir,
    }, eventSource, runtimeStateStore ?? new WorkerRuntimeStateStore());
  } catch (error) {
    logger.warn('worker-attention-notification.runtime-state', 'Failed to update worker runtime state', {
      sessionName: worker.sessionName,
      state,
      reason,
      error,
    });
  }
}

function getWorkerRuntimeErrorTitle(workerLabel: string, reason: WorkerRuntimeErrorReason): string {
  switch (reason) {
    case 'initial-prompt':
      return `${workerLabel} failed to receive its initial task`;
    case 'startup-timeout':
    case 'post-create':
      return `${workerLabel} failed during startup`;
    case 'start':
      return `${workerLabel} failed to start`;
    case 'message-delivery':
      return `${workerLabel} failed to receive a message`;
    case 'stop':
      return `${workerLabel} failed to stop`;
    case 'delete':
      return `${workerLabel} failed to delete`;
    case 'rename':
      return `${workerLabel} failed to rename`;
    case 'restore':
      return `${workerLabel} failed to restore`;
  }
}

function formatWorkerLabel(worker: WorkerInfo): string {
  return worker.workerId != null
    ? `Worker #${worker.workerId}`
    : `Worker ${worker.sessionName}`;
}

function formatNeedsInputBody(signal: WorkerNeedsInputSignal): string {
  const parts = [
    signal.title,
    signal.body,
    'Open the worker session to respond.',
  ].filter(Boolean);
  return truncateText(redactText(parts.join('\n\n'), NEEDS_INPUT_BODY_LIMIT), NEEDS_INPUT_BODY_LIMIT);
}

function formatErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : String(error);
  const redacted = redactText(raw || 'Unknown runtime error', ERROR_BODY_LIMIT);
  return truncateText(redacted, ERROR_BODY_LIMIT);
}

function normalizeErrorSignature(message: string): string {
  return message
    .replace(/\b\d{4,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
