import * as fs from 'fs';
import * as path from 'path';
import { CompletionJobStore, type CompletionJob } from './completionJobStore';
import type { HydraEventSource } from './events';
import { logger } from './logger';
import { NotificationStore, type HydraNotification } from './notifications';
import { getHydraHome } from './path';
import { isDirectoryWorker, type WorkerInfo } from './sessionManager';
import {
  WorkerRuntimeCoordinator,
  type WorkerRuntimeApplyOutcome,
} from './workerRuntimeCoordinator';
import {
  WorkerRuntimeStateStoreV2,
  type WorkerRuntimeSnapshotV2,
} from './workerRuntimeV2';

export interface CompletionWorkerIdentity {
  worker: WorkerInfo;
  lifecycleEpoch: string;
}

export type CompletionWorkerResolver = (workerId: number) => CompletionWorkerIdentity | undefined;

export interface CompletionSignal {
  workerId: number;
  lifecycleEpoch: string;
  observedAt?: string;
  sourceSequence?: number;
}

export type CompletionApplyOutcome =
  | 'completed'
  | 'duplicate'
  | 'no-pending-job'
  | 'stale-epoch'
  | 'worker-not-found'
  | 'runtime-rejected';

export interface CompletionApplyResult {
  outcome: CompletionApplyOutcome;
  job?: CompletionJob;
  runtime?: WorkerRuntimeSnapshotV2;
  runtimeOutcome?: WorkerRuntimeApplyOutcome;
  notification?: HydraNotification;
  migratedLegacyPending?: boolean;
  compatibilityDelivered?: boolean;
}

export interface CompletionCoordinatorOptions {
  resolveWorker: CompletionWorkerResolver;
  jobStore?: CompletionJobStore;
  runtimeStore?: WorkerRuntimeStateStoreV2;
  runtimeCoordinator: WorkerRuntimeCoordinator;
  notificationStore?: NotificationStore;
  deliverCompatibility?: (targetSession: string, message: string) => Promise<void>;
  eventSource?: HydraEventSource;
  now?: () => number;
  readLegacyPendingToken?: (sessionName: string) => string | undefined;
}

export class CompletionCoordinator {
  private readonly resolveWorker: CompletionWorkerResolver;
  private readonly jobStore: CompletionJobStore;
  private readonly runtimeStore: WorkerRuntimeStateStoreV2;
  private readonly runtimeCoordinator: WorkerRuntimeCoordinator;
  private readonly notificationStore: NotificationStore;
  private readonly deliverCompatibility?: (targetSession: string, message: string) => Promise<void>;
  private readonly eventSource: HydraEventSource;
  private readonly now: () => number;
  private readonly readLegacyPendingToken: (sessionName: string) => string | undefined;

  constructor(options: CompletionCoordinatorOptions) {
    this.resolveWorker = options.resolveWorker;
    this.jobStore = options.jobStore ?? new CompletionJobStore();
    this.runtimeStore = options.runtimeStore ?? new WorkerRuntimeStateStoreV2();
    this.runtimeCoordinator = options.runtimeCoordinator;
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    this.deliverCompatibility = options.deliverCompatibility;
    this.eventSource = options.eventSource ?? 'hook';
    this.now = options.now ?? Date.now;
    this.readLegacyPendingToken = options.readLegacyPendingToken ?? readLegacyCompletionPendingToken;
  }

  async complete(signal: CompletionSignal): Promise<CompletionApplyResult> {
    validateSignal(signal);
    const identity = this.resolveWorker(signal.workerId);
    if (!identity) {
      return this.reject('worker-not-found', signal);
    }
    if (identity.lifecycleEpoch !== signal.lifecycleEpoch) {
      return this.reject('stale-epoch', signal);
    }

    let migratedLegacyPending = false;
    const existingRuntime = this.runtimeStore.get(signal.workerId);
    let job = this.jobStore.getPending(signal.workerId, signal.lifecycleEpoch);
    if (!job
      && existingRuntime?.lifecycleEpoch === signal.lifecycleEpoch
      && existingRuntime.runId) {
      const completedJob = this.jobStore.getForRun(
        signal.workerId,
        signal.lifecycleEpoch,
        existingRuntime.runId,
      );
      if (completedJob?.status === 'fired') {
        job = completedJob;
      }
    }
    if (!job) {
      const legacyToken = this.readLegacyPendingToken(identity.worker.sessionName);
      const hasDurableHistory = this.jobStore.list()
        .some(candidate => candidate.workerId === signal.workerId);
      const runtimeActive = existingRuntime?.lifecycleEpoch === signal.lifecycleEpoch
        && (existingRuntime.state === 'running' || existingRuntime.state === 'needs-input')
        && !!existingRuntime.runId;
      if (legacyToken && !hasDurableHistory && runtimeActive && existingRuntime?.runId) {
        const armed = this.jobStore.armForDispatch({
          workerId: signal.workerId,
          lifecycleEpoch: signal.lifecycleEpoch,
          runId: existingRuntime.runId,
        }, {
          runtimeActive: true,
          runtimeRunId: existingRuntime.runId,
        });
        if (armed.job.status === 'pending') {
          job = armed.job;
          migratedLegacyPending = armed.created;
        }
      }
    }
    if (!job) {
      return this.reject('no-pending-job', signal, { migratedLegacyPending });
    }

    const current = this.runtimeStore.get(signal.workerId);
    const occurrenceId = `completion-occurrence:${job.jobId}`;
    const runtimeSignalId = `completion-job:${job.jobId}`;
    const runtimeResult = this.runtimeCoordinator.apply({
      workerId: signal.workerId,
      sessionName: identity.worker.sessionName,
      lifecycleEpoch: signal.lifecycleEpoch,
      runId: job.runId,
      revision: (current?.revision ?? -1) + 1,
      state: 'idle',
      signalId: runtimeSignalId,
      occurrenceId,
      sourceSequence: signal.sourceSequence,
      origin: 'hook',
      reason: 'complete',
      observedAt: signal.observedAt ?? timestamp(this.now()),
      agent: identity.worker.agent,
      workdir: identity.worker.workdir,
    }, this.eventSource);

    if (runtimeResult.outcome !== 'applied' && runtimeResult.outcome !== 'duplicate') {
      return this.reject('runtime-rejected', signal, {
        job,
        runtime: runtimeResult.snapshot,
        runtimeOutcome: runtimeResult.outcome,
        migratedLegacyPending,
      });
    }

    const authoritative = this.runtimeStore.get(signal.workerId) ?? runtimeResult.snapshot;
    if (!authoritative
      || authoritative.lifecycleEpoch !== job.lifecycleEpoch
      || authoritative.runId !== job.runId
      || (authoritative.signalId !== runtimeSignalId && authoritative.state !== 'idle')) {
      return this.reject('runtime-rejected', signal, {
        job,
        runtime: authoritative,
        runtimeOutcome: runtimeResult.outcome,
        migratedLegacyPending,
      });
    }

    const routedIdentity = this.resolveWorker(signal.workerId);
    if (!routedIdentity) {
      return this.reject('worker-not-found', signal, {
        job,
        runtime: authoritative,
        runtimeOutcome: runtimeResult.outcome,
        migratedLegacyPending,
      });
    }
    if (routedIdentity.lifecycleEpoch !== job.lifecycleEpoch) {
      return this.reject('stale-epoch', signal, {
        job,
        runtime: authoritative,
        runtimeOutcome: runtimeResult.outcome,
        migratedLegacyPending,
      });
    }

    const content = buildCompletionContent(routedIdentity.worker);
    const notificationResult = this.notificationStore.create({
      kind: 'complete',
      title: content.title,
      body: content.body,
      targetSession: routedIdentity.worker.copilotSessionName,
      sourceSession: routedIdentity.worker.sessionName,
      dedupeKey: runtimeSignalId,
      action: { type: 'open-session', session: routedIdentity.worker.sessionName },
      context: {
        workerId: routedIdentity.worker.workerId,
        branch: routedIdentity.worker.branch,
        workdir: routedIdentity.worker.workdir,
        agent: routedIdentity.worker.agent,
      },
      occurrenceId,
      lifecycleEpoch: job.lifecycleEpoch,
      runId: job.runId,
      signalId: runtimeSignalId,
      eventSource: this.eventSource,
    });

    const fired = this.jobStore.markFired(job.jobId, {
      workerId: job.workerId,
      lifecycleEpoch: job.lifecycleEpoch,
      runId: job.runId,
    });

    let compatibilityDelivered = false;
    const target = routedIdentity.worker.copilotSessionName;
    if (notificationResult.created && target && this.deliverCompatibility) {
      try {
        await this.deliverCompatibility(target, content.body);
        compatibilityDelivered = true;
      } catch (error) {
        logger.warn('completion-coordinator.compatibility-delivery', 'Failed to deliver compatibility completion message', {
          workerId: signal.workerId,
          sessionName: routedIdentity.worker.sessionName,
          targetSession: target,
          jobId: job.jobId,
          error,
        });
      }
    }

    return {
      outcome: notificationResult.created ? 'completed' : 'duplicate',
      job: fired.job,
      runtime: authoritative,
      runtimeOutcome: runtimeResult.outcome,
      notification: notificationResult.notification,
      migratedLegacyPending,
      compatibilityDelivered,
    };
  }

  private reject(
    outcome: Exclude<CompletionApplyOutcome, 'completed' | 'duplicate'>,
    signal: CompletionSignal,
    details: Omit<CompletionApplyResult, 'outcome'> = {},
  ): CompletionApplyResult {
    logger.warn('completion-coordinator.rejected', 'Rejected worker completion signal', {
      outcome,
      workerId: signal.workerId,
      lifecycleEpoch: signal.lifecycleEpoch,
      ...details.job ? { jobId: details.job.jobId, runId: details.job.runId } : {},
      runtimeOutcome: details.runtimeOutcome,
    });
    return { outcome, ...details };
  }
}

export function readLegacyCompletionPendingToken(sessionName: string): string | undefined {
  const normalized = sessionName.trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('\0')) {
    return undefined;
  }
  const pendingPath = path.join(getHydraHome(), 'hooks', `notify-${normalized}.pending`);
  try {
    const token = fs.readFileSync(pendingPath, 'utf-8').trim();
    return token || 'legacy';
  } catch {
    return undefined;
  }
}

function buildCompletionContent(worker: WorkerInfo): { title: string; body: string } {
  const name = worker.displayName || worker.slug || worker.sessionName;
  if (isDirectoryWorker(worker)) {
    return {
      title: `Task worker #${worker.workerId} completed`,
      body: `Task worker #${worker.workerId} (${name}) has completed. Workdir: ${worker.workdir}. Use \`hydra worker logs ${worker.sessionName}\` to review output.`,
    };
  }
  return {
    title: `Worker #${worker.workerId} completed`,
    body: `Worker #${worker.workerId} (${name}) has completed. Branch: ${worker.branch || 'unknown'}. Use \`hydra worker logs ${worker.sessionName}\` to review output.`,
  };
}

function validateSignal(signal: CompletionSignal): void {
  if (!Number.isSafeInteger(signal.workerId) || signal.workerId <= 0) {
    throw new Error('Completion signal workerId must be a positive safe integer');
  }
  validateRequiredString(signal.lifecycleEpoch, 'lifecycleEpoch');
  if (signal.observedAt !== undefined && !Number.isFinite(Date.parse(signal.observedAt))) {
    throw new Error('Completion signal observedAt must be a valid timestamp');
  }
  if (signal.sourceSequence !== undefined
    && (!Number.isSafeInteger(signal.sourceSequence) || signal.sourceSequence < 0)) {
    throw new Error('Completion signal sourceSequence must be a non-negative safe integer');
  }
}

function validateRequiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error(`Completion signal ${field} must be a non-empty string of at most 500 characters`);
  }
}

function timestamp(now: number): string {
  if (!Number.isFinite(now)) throw new Error('Completion coordinator clock returned a non-finite timestamp');
  return new Date(Math.trunc(now)).toISOString();
}
