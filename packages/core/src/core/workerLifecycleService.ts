import { randomUUID } from 'crypto';
import { agentSupportsCompletionNotification } from './agentConfig';
import { CompletionJobStore, type CompletionJob } from './completionJobStore';
import { removeLegacyCompletionPendingFiles } from './completionHookScript';
import { EventLog, type HydraEventSource } from './events';
import { logger } from './logger';
import { NotificationStore } from './notifications';
import {
  SessionManager,
  type CreateDirectoryWorkerOpts,
  type CreateWorkerOpts,
  type CreateWorkerResult,
  type DeleteWorkerOpts,
  type WorkerInfo,
} from './sessionManager';
import type { MultiplexerBackendCore } from './types';
import {
  classifyRuntimeErrorReason,
  publishWorkerRuntimeErrorNotification,
  type WorkerRuntimeErrorReason,
} from './workerAttentionNotifications';
import { WorkerRuntimeCoordinator, type WorkerRuntimeIdentity } from './workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from './workerRuntimeState';
import { WorkerRuntimeStateStoreV2, type WorkerRuntimeSnapshotV2 } from './workerRuntimeV2';
import { getWorkerLifecycleEpoch, normalizeWorkerSessionAliases } from './workerIdentity';

export type WorkerSelector = string | number;

export interface WorkerMessageOptions {
  actorSessionName?: string | null;
  /** Legacy name: this controls parent-terminal compatibility delivery, not tracking. */
  notifyCompletion?: boolean;
  reason?: string;
}

export interface WorkerMessageResult {
  worker: WorkerInfo;
  completionArmed: boolean;
}

export interface WorkerBroadcastResult {
  workers: WorkerInfo[];
}

export interface WorkerLifecycleServiceOptions {
  backend: MultiplexerBackendCore;
  sessionManager?: SessionManager;
  notificationStore?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
  runtimeV2Store?: WorkerRuntimeStateStoreV2;
  runtimeCoordinator?: WorkerRuntimeCoordinator;
  completionJobStore?: CompletionJobStore;
  eventLog?: EventLog;
  eventSource?: HydraEventSource;
}

interface PreparedWorkerDispatch {
  completionJob?: CompletionJob;
  completionJobCreated: boolean;
  lifecycleEpoch: string;
  runId: string;
}

/**
 * Shared worker mutation path for CLI, VS Code, and sidecar clients.
 *
 * SessionManager remains responsible for session/git/tmux persistence. This
 * service owns the cross-cutting lifecycle sequence around those primitives:
 * completion intent, runtime transitions, delivery, and error publication.
 */
export class WorkerLifecycleService {
  private readonly backend: MultiplexerBackendCore;
  private readonly sessionManager: SessionManager;
  private readonly notificationStore: NotificationStore;
  private readonly runtimeStateStore: WorkerRuntimeStateStore;
  private readonly runtimeV2Store: WorkerRuntimeStateStoreV2;
  private readonly runtimeCoordinator: WorkerRuntimeCoordinator;
  private readonly completionJobStore: CompletionJobStore;
  private readonly eventSource: HydraEventSource;

  constructor(options: WorkerLifecycleServiceOptions) {
    this.backend = options.backend;
    this.sessionManager = options.sessionManager ?? new SessionManager(options.backend);
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    this.runtimeStateStore = options.runtimeStateStore ?? new WorkerRuntimeStateStore();
    this.runtimeV2Store = options.runtimeV2Store ?? new WorkerRuntimeStateStoreV2();
    this.completionJobStore = options.completionJobStore ?? new CompletionJobStore();
    this.eventSource = options.eventSource ?? 'session-manager';
    this.runtimeCoordinator = options.runtimeCoordinator ?? new WorkerRuntimeCoordinator(
      workerId => this.resolveRuntimeIdentity(workerId),
      this.runtimeV2Store,
      this.runtimeStateStore,
      options.eventLog ?? new EventLog(),
    );
  }

  async createWorker(options: CreateWorkerOpts): Promise<CreateWorkerResult> {
    await this.sessionManager.ensurePersistedWorkerIdentities();
    return this.prepareCreatedWorker(
      await this.sessionManager.createWorker(options),
      options.notifyCopilot !== false,
    );
  }

  async createDirectoryWorker(options: CreateDirectoryWorkerOpts): Promise<CreateWorkerResult> {
    await this.sessionManager.ensurePersistedWorkerIdentities();
    return this.prepareCreatedWorker(
      await this.sessionManager.createDirectoryWorker(options),
      options.notifyCopilot !== false,
    );
  }

  async startWorker(
    selector: WorkerSelector,
    agentType?: string,
    agentCommand?: string,
  ): Promise<CreateWorkerResult> {
    const worker = await this.resolveWorker(selector);
    try {
      return this.prepareReadyWorker(
        await this.sessionManager.startWorker(worker.sessionName, agentType, agentCommand),
        'worker-starting',
        'start',
      );
    } catch (error) {
      const currentWorker = this.resolveCurrentWorkerIdentity(worker);
      this.cancelStaleCompletionIntents(currentWorker, getWorkerLifecycleEpoch(currentWorker));
      this.publishError(currentWorker, error, 'start');
      throw error;
    }
  }

  async sendWorkerMessage(
    selector: WorkerSelector,
    message: string,
    options: WorkerMessageOptions = {},
  ): Promise<WorkerMessageResult> {
    const worker = await this.resolveWorker(selector);
    return this.sendResolvedWorkerMessage(worker, message, options);
  }

  private async sendResolvedWorkerMessage(
    worker: WorkerInfo,
    message: string,
    options: WorkerMessageOptions,
  ): Promise<WorkerMessageResult> {
    let dispatch: PreparedWorkerDispatch | undefined;
    try {
      await this.sessionManager.assertHydraSessionOwnership(worker.sessionName, 'worker');
      dispatch = this.prepareDispatch(
        worker,
        options.reason || 'worker-send',
        options.notifyCompletion !== false,
      );
      await this.backend.sendMessage(worker.sessionName, message);
      return { worker, completionArmed: !!dispatch.completionJob };
    } catch (error) {
      if (dispatch?.completionJobCreated && dispatch.completionJob) {
        this.cancelCompletionJob(dispatch.completionJob, 'message-delivery-failed');
      }
      this.publishError(worker, error, 'message-delivery');
      throw error;
    }
  }

  async broadcastToWorkers(
    message: string,
    options: WorkerMessageOptions = {},
  ): Promise<WorkerBroadcastResult> {
    const state = await this.sessionManager.sync();
    const workers = Object.values(state.workers).filter(worker => worker.status === 'running');
    if (workers.length === 0) {
      throw new Error('No running workers found');
    }
    for (const worker of workers) {
      await this.sendResolvedWorkerMessage(worker, message, {
        ...options,
        reason: options.reason || 'worker-broadcast',
      });
    }
    return { workers };
  }

  async stopWorker(selector: WorkerSelector): Promise<WorkerInfo> {
    const worker = await this.resolveWorker(selector);
    try {
      await this.sessionManager.stopWorker(worker.sessionName);
      this.cancelCompletionIntent(worker, 'worker-stopped');
      this.resolveWorkerNeedsInput(worker.workerId, 'worker-stopped');
      this.runtimeCoordinator.clear(worker.workerId);
      return worker;
    } catch (error) {
      this.publishError(worker, error, 'stop');
      throw error;
    }
  }

  async deleteWorker(
    selector: WorkerSelector,
    options: DeleteWorkerOpts = {},
  ): Promise<WorkerInfo> {
    const worker = await this.resolveWorker(selector);
    try {
      await this.sessionManager.deleteWorker(worker.sessionName, options);
      this.cancelCompletionIntent(worker, 'worker-deleted');
      this.resolveWorkerNeedsInput(worker.workerId, 'worker-deleted');
      this.runtimeCoordinator.clear(worker.workerId);
      return worker;
    } catch (error) {
      this.publishError(worker, error, 'delete');
      throw error;
    }
  }

  async renameWorker(selector: WorkerSelector, newBranchName: string): Promise<WorkerInfo> {
    const worker = await this.resolveWorker(selector);
    try {
      const renamed = await this.sessionManager.renameWorker(worker.sessionName, newBranchName);
      this.refreshRuntimeRoute(renamed, 'worker-renamed');
      this.refreshNotificationRoute(renamed);
      return renamed;
    } catch (error) {
      this.publishError(worker, error, 'rename');
      throw error;
    }
  }

  async restoreWorker(sessionName: string): Promise<CreateWorkerResult> {
    await this.sessionManager.ensurePersistedWorkerIdentities();
    const archived = this.sessionManager.getArchived(sessionName);
    const worker = archived?.type === 'worker' ? archived.data as WorkerInfo : undefined;
    try {
      const result = await this.sessionManager.restoreWorker(sessionName);
      if (worker) {
        this.cancelCompletionIntent(worker, 'worker-restored');
        this.resolveWorkerNeedsInput(worker.workerId, 'worker-restored');
      }
      return this.prepareReadyWorker(result, 'worker-restoring', 'restore');
    } catch (error) {
      if (worker) {
        const currentWorker = this.resolveCurrentWorkerIdentity(worker);
        this.cancelStaleCompletionIntents(currentWorker, getWorkerLifecycleEpoch(currentWorker));
        this.publishError(currentWorker, error, 'restore');
      }
      throw error;
    }
  }

  private async prepareCreatedWorker(
    result: CreateWorkerResult,
    deliverCompatibilityToCopilot: boolean,
  ): Promise<CreateWorkerResult> {
    this.applyInitialUnknownTransition(result.workerInfo, 'worker-creating');
    if (!result.deliverInitialPrompt) {
      return this.prepareReadyWorker(result, 'worker-creating', 'post-create', true);
    }

    const deliverInitialPrompt = result.deliverInitialPrompt;
    let dispatch: PreparedWorkerDispatch | undefined;
    const postCreatePromise = result.postCreatePromise
      .then(async () => {
        await this.sessionManager.assertHydraSessionOwnership(result.workerInfo.sessionName, 'worker');
        dispatch = this.prepareDispatch(
          result.workerInfo,
          'worker-initial-prompt',
          deliverCompatibilityToCopilot,
        );
        await deliverInitialPrompt();
      })
      .catch((error) => {
        if (dispatch?.completionJobCreated && dispatch.completionJob) {
          this.cancelCompletionJob(dispatch.completionJob, 'initial-prompt-failed');
        }
        this.publishError(result.workerInfo, error, classifyRuntimeErrorReason(error));
        throw error;
      });
    return {
      workerInfo: result.workerInfo,
      postCreatePromise,
    };
  }

  private prepareReadyWorker(
    result: CreateWorkerResult,
    startingReason: 'worker-creating' | 'worker-starting' | 'worker-restoring',
    errorReason: WorkerRuntimeErrorReason,
    alreadyInitialized = false,
  ): CreateWorkerResult {
    if (!alreadyInitialized) {
      this.applyInitialUnknownTransition(result.workerInfo, startingReason);
    }
    const lifecycleEpoch = getWorkerLifecycleEpoch(result.workerInfo);
    this.cancelStaleCompletionIntents(result.workerInfo, lifecycleEpoch);
    const postCreatePromise = result.postCreatePromise
      .then(async () => {
        await this.sessionManager.assertHydraSessionOwnership(result.workerInfo.sessionName, 'worker');
        this.applyReadyTransition(result.workerInfo, lifecycleEpoch);
      })
      .catch((error) => {
        this.publishError(
          result.workerInfo,
          error,
          errorReason === 'post-create' ? classifyRuntimeErrorReason(error) : errorReason,
        );
        throw error;
      });
    return { ...result, postCreatePromise };
  }

  private async resolveWorker(selector: WorkerSelector): Promise<WorkerInfo> {
    await this.sessionManager.ensurePersistedWorkerIdentities();
    const persistedWorker = typeof selector === 'number'
      ? this.sessionManager.listPersistedWorkers().find(candidate => candidate.workerId === selector)
      : this.sessionManager.getPersistedWorker(selector);
    const worker = persistedWorker ?? (typeof selector === 'number'
      ? (await this.sessionManager.listWorkers()).find(candidate => candidate.workerId === selector)
      : await this.sessionManager.getWorker(selector));
    if (!worker) {
      const label = typeof selector === 'number' ? `#${selector}` : `"${selector}"`;
      throw new Error(`Worker ${label} not found`);
    }
    return worker;
  }

  private prepareDispatch(
    worker: WorkerInfo,
    reason: string,
    deliverCompatibilityToCopilot: boolean,
  ): PreparedWorkerDispatch {
    const before = this.runtimeV2Store.get(worker.workerId);
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    this.cancelStaleCompletionIntents(worker, lifecycleEpoch);
    const runtimeActive = before?.lifecycleEpoch === lifecycleEpoch
      && (before.state === 'running' || before.state === 'needs-input')
      && !!before.runId;
    const proposedRunId = runtimeActive && before?.runId ? before.runId : randomUUID();
    let completionJob: CompletionJob | undefined;
    let completionJobCreated = false;

    try {
      if (agentSupportsCompletionNotification(worker.agent)) {
        const hookAvailable = this.sessionManager.ensureWorkerCompletionHook(worker);
        if (!hookAvailable) {
          logger.warn('worker-lifecycle.completion-unavailable', 'Worker dispatch will continue without completion tracking', {
            sessionName: worker.sessionName,
            workerId: worker.workerId,
            agent: worker.agent,
          });
        } else {
          const armed = this.completionJobStore.armForDispatch({
            workerId: worker.workerId,
            lifecycleEpoch,
            runId: proposedRunId,
            deliverCompatibilityToCopilot,
          }, {
            runtimeActive,
            runtimeRunId: before?.runId ?? null,
          });
          if (armed.job.status !== 'pending') {
            throw new Error(`Completion job for worker #${worker.workerId} run ${armed.job.runId} is already ${armed.job.status}`);
          }
          if ((armed.job.deliverCompatibilityToCopilot !== false) !== deliverCompatibilityToCopilot) {
            logger.warn('worker-lifecycle.completion-policy', 'Existing completion job retains its original compatibility delivery policy', {
              workerId: worker.workerId,
              lifecycleEpoch,
              runId: armed.job.runId,
              requested: deliverCompatibilityToCopilot,
              retained: armed.job.deliverCompatibilityToCopilot !== false,
            });
          }
          completionJob = armed.job;
          completionJobCreated = armed.created;
        }
      }

      const runId = completionJob?.runId ?? proposedRunId;
      if (completionJob) {
        this.applyRunningTransition(worker, lifecycleEpoch, runId, reason);
      } else {
        this.applyUnknownTransition(worker, lifecycleEpoch, runId, 'completion-tracking-unavailable');
      }
      if (before?.state === 'needs-input') {
        if (before.lifecycleEpoch === lifecycleEpoch && before.runId === runId) {
          this.resolveNeedsInputOccurrences(worker.workerId, lifecycleEpoch, runId, 'worker-message');
        } else {
          this.resolveWorkerNeedsInput(worker.workerId, 'worker-recreated');
        }
      }
      return { completionJob, completionJobCreated, lifecycleEpoch, runId };
    } catch (error) {
      if (completionJobCreated && completionJob) {
        this.cancelCompletionJob(completionJob, 'dispatch-preparation-failed');
      }
      throw error;
    }
  }

  private applyRunningTransition(
    worker: WorkerInfo,
    lifecycleEpoch: string,
    runId: string,
    reason: string,
  ): WorkerRuntimeSnapshotV2 {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId,
        revision: (current?.revision ?? -1) + 1,
        state: 'running',
        signalId: randomUUID(),
        origin: 'lifecycle',
        reason,
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied' && result.snapshot) return result.snapshot;
      if (result.outcome !== 'stale-revision') {
        throw new Error(`Worker runtime running transition was rejected with ${result.outcome}`);
      }
    }
    throw new Error(`Worker runtime running transition for #${worker.workerId} did not converge`);
  }

  private applyInitialUnknownTransition(
    worker: WorkerInfo,
    reason: 'worker-creating' | 'worker-starting' | 'worker-restoring',
  ): WorkerRuntimeSnapshotV2 {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      const currentEpoch = current?.lifecycleEpoch === lifecycleEpoch ? current : undefined;
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: null,
        revision: (currentEpoch?.revision ?? -1) + 1,
        state: 'unknown',
        signalId: randomUUID(),
        origin: 'lifecycle',
        reason,
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied' && result.snapshot) return result.snapshot;
      if (result.outcome !== 'stale-revision') {
        throw new Error(`Worker runtime initialization was rejected with ${result.outcome}`);
      }
    }
    throw new Error(`Worker runtime initialization for #${worker.workerId} did not converge`);
  }

  private applyReadyTransition(
    worker: WorkerInfo,
    lifecycleEpoch: string,
  ): WorkerRuntimeSnapshotV2 {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      const currentEpoch = current?.lifecycleEpoch === lifecycleEpoch ? current : undefined;
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: null,
        revision: (currentEpoch?.revision ?? -1) + 1,
        state: 'idle',
        signalId: randomUUID(),
        origin: 'lifecycle',
        reason: 'worker-ready',
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied' && result.snapshot) return result.snapshot;
      if (result.outcome !== 'stale-revision') {
        throw new Error(`Worker runtime ready transition was rejected with ${result.outcome}`);
      }
    }
    throw new Error(`Worker runtime ready transition for #${worker.workerId} did not converge`);
  }

  private applyUnknownTransition(
    worker: WorkerInfo,
    lifecycleEpoch: string,
    runId: string,
    reason: 'completion-tracking-unavailable',
  ): WorkerRuntimeSnapshotV2 {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId,
        revision: (current?.revision ?? -1) + 1,
        state: 'unknown',
        signalId: randomUUID(),
        origin: 'lifecycle',
        reason,
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied' && result.snapshot) return result.snapshot;
      if (result.outcome !== 'stale-revision') {
        throw new Error(`Worker runtime unknown transition was rejected with ${result.outcome}`);
      }
    }
    throw new Error(`Worker runtime unknown transition for #${worker.workerId} did not converge`);
  }

  private refreshRuntimeRoute(worker: WorkerInfo, reason: string): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      if (!current || current.sessionName === worker.sessionName) return;
      const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
      if (current.lifecycleEpoch !== lifecycleEpoch) return;
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: current.runId,
        revision: current.revision + 1,
        state: current.state,
        signalId: randomUUID(),
        occurrenceId: current.occurrenceId,
        origin: 'lifecycle',
        reason,
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied') return;
      if (result.outcome !== 'stale-revision') {
        logger.warn('worker-lifecycle.runtime-route', 'Worker runtime route migration was rejected', {
          workerId: worker.workerId,
          sessionName: worker.sessionName,
          lifecycleEpoch,
          outcome: result.outcome,
        });
        return;
      }
    }
    logger.warn('worker-lifecycle.runtime-route', 'Worker runtime route migration did not converge', {
      workerId: worker.workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
    });
  }

  private refreshNotificationRoute(worker: WorkerInfo): void {
    try {
      this.notificationStore.rerouteActiveWorker(worker.workerId, worker.sessionName);
    } catch (error) {
      logger.warn('worker-lifecycle.notification-route', 'Failed to migrate active notification routes after rename', {
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        error,
      });
    }
  }

  private resolveNeedsInputOccurrences(
    workerId: number,
    lifecycleEpoch: string,
    runId: string,
    reason: string,
  ): void {
    const active = this.notificationStore.listOccurrences('active')
      .filter(notification => notification.workerId === workerId
        && notification.lifecycleEpoch === lifecycleEpoch
        && notification.runId === runId
        && notification.kind === 'needs-input');
    for (const notification of active) {
      this.notificationStore.resolve(notification.id, reason, this.eventSource);
    }
  }

  private resolveWorkerNeedsInput(workerId: number, reason: string): void {
    const active = this.notificationStore.listOccurrences('active')
      .filter(notification => notification.workerId === workerId && notification.kind === 'needs-input');
    for (const notification of active) {
      this.notificationStore.resolve(notification.id, reason, this.eventSource);
    }
  }

  private resolveRuntimeIdentity(workerId: number): WorkerRuntimeIdentity | undefined {
    const worker = this.sessionManager.listPersistedWorkers()
      .find(candidate => candidate.workerId === workerId);
    if (!worker) return undefined;
    return {
      workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      agent: worker.agent,
      workdir: worker.workdir,
    };
  }

  private resolveCurrentWorkerIdentity(fallback: WorkerInfo): WorkerInfo {
    return this.sessionManager.listPersistedWorkers()
      .find(worker => worker.workerId === fallback.workerId)
      ?? fallback;
  }

  private cancelCompletionIntent(worker: WorkerInfo, reason: string): boolean {
    let cancelled = false;
    try {
      cancelled = this.completionJobStore.cancelPending(worker.workerId, reason).length > 0;
    } catch (error) {
      logger.warn('worker-lifecycle.completion-cancel', 'Failed to cancel worker completion intent', {
        sessionName: worker.sessionName,
        workerId: worker.workerId,
        reason,
        error,
      });
    }
    try {
      removeLegacyCompletionPendingFiles([
        worker.sessionName,
        ...normalizeWorkerSessionAliases(worker),
      ]);
    } catch (error) {
      logger.warn('worker-lifecycle.legacy-completion-cleanup', 'Failed to remove legacy worker completion intent', {
        sessionName: worker.sessionName,
        workerId: worker.workerId,
        reason,
        error,
      });
    }
    return cancelled;
  }

  private cancelStaleCompletionIntents(worker: WorkerInfo, lifecycleEpoch: string): boolean {
    try {
      return this.completionJobStore.cancelPendingOutsideEpoch(
        worker.workerId,
        lifecycleEpoch,
        'stale-lifecycle-epoch',
      ).length > 0;
    } catch (error) {
      logger.warn('worker-lifecycle.completion-cancel', 'Failed to cancel stale worker completion intent', {
        sessionName: worker.sessionName,
        workerId: worker.workerId,
        lifecycleEpoch,
        error,
      });
      return false;
    }
  }

  private cancelCompletionJob(job: CompletionJob, reason: string): boolean {
    try {
      return this.completionJobStore.cancelJob(job.jobId, reason).changed;
    } catch (error) {
      logger.warn('worker-lifecycle.completion-cancel', 'Failed to cancel worker completion job', {
        sessionName: this.sessionManager.listPersistedWorkers()
          .find(worker => worker.workerId === job.workerId)?.sessionName,
        workerId: job.workerId,
        jobId: job.jobId,
        reason,
        error,
      });
      return false;
    }
  }

  private publishError(worker: WorkerInfo, error: unknown, reason: WorkerRuntimeErrorReason): void {
    const currentWorker = this.resolveCurrentWorkerIdentity(worker);
    let runtime: WorkerRuntimeSnapshotV2 | undefined;
    try {
      runtime = this.applyErrorTransition(currentWorker, reason);
    } catch (runtimeError) {
      logger.warn('worker-lifecycle.error-runtime', 'Failed to apply worker runtime error transition', {
        sessionName: currentWorker.sessionName,
        workerId: currentWorker.workerId,
        reason,
        error: runtimeError,
      });
    }
    const result = publishWorkerRuntimeErrorNotification(currentWorker, error, {
      eventSource: this.eventSource,
      reason,
      store: this.notificationStore,
      runtimeStateStore: this.runtimeStateStore,
      updateRuntime: false,
      occurrenceId: runtime?.occurrenceId,
      lifecycleEpoch: runtime?.lifecycleEpoch,
      runId: runtime?.runId ?? undefined,
      signalId: runtime?.signalId,
    });
    logger.warn('worker-lifecycle.error', 'Worker lifecycle operation failed', {
      sessionName: currentWorker.sessionName,
      workerId: currentWorker.workerId,
      reason,
      notificationStatus: result.created ? 'created' : result.skipped || 'existing',
      error,
    });
  }

  private applyErrorTransition(
    worker: WorkerInfo,
    reason: WorkerRuntimeErrorReason,
  ): WorkerRuntimeSnapshotV2 {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.runtimeV2Store.get(worker.workerId);
      const currentEpoch = current?.lifecycleEpoch === lifecycleEpoch ? current : undefined;
      const occurrenceId = randomUUID();
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: currentEpoch?.runId ?? null,
        revision: (currentEpoch?.revision ?? -1) + 1,
        state: 'error',
        signalId: randomUUID(),
        occurrenceId,
        origin: 'lifecycle',
        reason,
        observedAt: new Date().toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      if (result.outcome === 'applied' && result.snapshot) return result.snapshot;
      if (result.outcome !== 'stale-revision') {
        throw new Error(`Worker runtime error transition was rejected with ${result.outcome}`);
      }
    }
    throw new Error(`Worker runtime error transition for #${worker.workerId} did not converge`);
  }
}
