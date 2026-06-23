import { type HydraEventSource } from './events';
import { hashText, redactText, truncateText } from './logRedaction';
import { logger } from './logger';
import {
  NotificationStore,
  type CreateNotificationResult,
  type HydraNotification,
  type NotificationKind,
} from './notifications';
import type { WorkerInfo } from './sessionManager';

export type WorkerRuntimeErrorReason = 'post-create' | 'initial-prompt' | 'startup-timeout';

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
}

export type PublishWorkerAttentionNotificationResult =
  | (CreateNotificationResult & { skipped?: undefined })
  | { created: false; notification?: undefined; skipped: 'missing-target' | 'store-failed' };

const ERROR_BODY_LIMIT = 600;

export function publishWorkerAttentionNotification(
  input: PublishWorkerAttentionNotificationInput,
): PublishWorkerAttentionNotificationResult {
  const targetCopilotSession = input.targetCopilotSession?.trim();
  if (!targetCopilotSession) {
    return { created: false, skipped: 'missing-target' };
  }

  try {
    return (input.store ?? new NotificationStore()).create({
      kind: input.kind,
      title: input.title,
      body: input.body,
      targetSession: targetCopilotSession,
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

  return publishWorkerAttentionNotification({
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

function getWorkerRuntimeErrorTitle(workerLabel: string, reason: WorkerRuntimeErrorReason): string {
  switch (reason) {
    case 'initial-prompt':
      return `${workerLabel} failed to receive its initial task`;
    case 'startup-timeout':
    case 'post-create':
      return `${workerLabel} failed during startup`;
  }
}

function formatWorkerLabel(worker: WorkerInfo): string {
  return worker.workerId != null
    ? `Worker #${worker.workerId}`
    : `Worker ${worker.sessionName}`;
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
