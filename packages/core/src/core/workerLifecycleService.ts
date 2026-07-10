import { agentSupportsCompletionNotification } from './agentConfig';
import type { HydraEventSource } from './events';
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
  awaitWorkerPostCreateOrPublishError,
  publishWorkerRuntimeErrorNotification,
  type WorkerRuntimeErrorReason,
} from './workerAttentionNotifications';
import { setWorkerRuntimeState, WorkerRuntimeStateStore } from './workerRuntimeState';

export type WorkerSelector = string | number;

export interface WorkerMessageOptions {
  actorSessionName?: string | null;
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
  eventSource?: HydraEventSource;
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
  private readonly eventSource: HydraEventSource;

  constructor(options: WorkerLifecycleServiceOptions) {
    this.backend = options.backend;
    this.sessionManager = options.sessionManager ?? new SessionManager(options.backend);
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    this.runtimeStateStore = options.runtimeStateStore ?? new WorkerRuntimeStateStore();
    this.eventSource = options.eventSource ?? 'session-manager';
  }

  async createWorker(options: CreateWorkerOpts): Promise<CreateWorkerResult> {
    return this.wrapPostCreate(await this.sessionManager.createWorker(options));
  }

  async createDirectoryWorker(options: CreateDirectoryWorkerOpts): Promise<CreateWorkerResult> {
    return this.wrapPostCreate(await this.sessionManager.createDirectoryWorker(options));
  }

  async startWorker(
    selector: WorkerSelector,
    agentType?: string,
    agentCommand?: string,
  ): Promise<CreateWorkerResult> {
    const worker = await this.resolveWorker(selector);
    try {
      return this.wrapPostCreate(
        await this.sessionManager.startWorker(worker.sessionName, agentType, agentCommand),
      );
    } catch (error) {
      this.publishError(worker, error, 'start');
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
    let completionArmed = false;
    try {
      await this.sessionManager.assertHydraSessionOwnership(worker.sessionName, 'worker');
      const notifyCompletion = options.notifyCompletion
        ?? (!!options.actorSessionName && options.actorSessionName === worker.copilotSessionName);
      if (
        notifyCompletion
        && !!worker.copilotSessionName
        && agentSupportsCompletionNotification(worker.agent)
      ) {
        completionArmed = this.sessionManager.armCompletionNotification(worker.sessionName);
      }

      this.markRunning(worker, options.reason || 'worker-send');
      await this.backend.sendMessage(worker.sessionName, message);
      return { worker, completionArmed };
    } catch (error) {
      if (completionArmed) {
        this.cancelCompletionIntent(worker, 'message-delivery-failed');
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
      return worker;
    } catch (error) {
      this.publishError(worker, error, 'delete');
      throw error;
    }
  }

  async renameWorker(selector: WorkerSelector, newBranchName: string): Promise<WorkerInfo> {
    const worker = await this.resolveWorker(selector);
    try {
      return await this.sessionManager.renameWorker(worker.sessionName, newBranchName);
    } catch (error) {
      this.publishError(worker, error, 'rename');
      throw error;
    }
  }

  async restoreWorker(sessionName: string): Promise<CreateWorkerResult> {
    const archived = this.sessionManager.getArchived(sessionName);
    const worker = archived?.type === 'worker' ? archived.data as WorkerInfo : undefined;
    try {
      return this.wrapPostCreate(await this.sessionManager.restoreWorker(sessionName));
    } catch (error) {
      if (worker) this.publishError(worker, error, 'restore');
      throw error;
    }
  }

  private wrapPostCreate(result: CreateWorkerResult): CreateWorkerResult {
    return {
      ...result,
      postCreatePromise: awaitWorkerPostCreateOrPublishError(
        result.workerInfo,
        result.postCreatePromise,
        {
          eventSource: this.eventSource,
          store: this.notificationStore,
          runtimeStateStore: this.runtimeStateStore,
        },
      ),
    };
  }

  private async resolveWorker(selector: WorkerSelector): Promise<WorkerInfo> {
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

  private markRunning(worker: WorkerInfo, reason: string): void {
    setWorkerRuntimeState({
      sessionName: worker.sessionName,
      state: 'running',
      origin: 'manual',
      reason,
      workerId: worker.workerId,
      agent: worker.agent,
      workdir: worker.workdir,
    }, this.eventSource, this.runtimeStateStore);
  }

  private cancelCompletionIntent(worker: WorkerInfo, reason: string): boolean {
    try {
      return this.sessionManager.cancelCompletionNotification(worker.sessionName);
    } catch (error) {
      logger.warn('worker-lifecycle.completion-cancel', 'Failed to cancel worker completion intent', {
        sessionName: worker.sessionName,
        workerId: worker.workerId,
        reason,
        error,
      });
      return false;
    }
  }

  private publishError(worker: WorkerInfo, error: unknown, reason: WorkerRuntimeErrorReason): void {
    const result = publishWorkerRuntimeErrorNotification(worker, error, {
      eventSource: this.eventSource,
      reason,
      store: this.notificationStore,
      runtimeStateStore: this.runtimeStateStore,
    });
    logger.warn('worker-lifecycle.error', 'Worker lifecycle operation failed', {
      sessionName: worker.sessionName,
      workerId: worker.workerId,
      reason,
      notificationStatus: result.created ? 'created' : result.skipped || 'existing',
      error,
    });
  }
}
