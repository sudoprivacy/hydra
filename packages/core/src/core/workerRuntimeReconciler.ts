import { CompletionJobStore } from './completionJobStore';
import { type HydraEventSource } from './events';
import { logger } from './logger';
import type { WorkerInfo } from './sessionManager';
import { getWorkerLifecycleEpoch } from './workerIdentity';
import {
  WorkerRuntimeCoordinator,
  type WorkerRuntimeApplyOutcome,
} from './workerRuntimeCoordinator';
import { WorkerRuntimeStateStoreV2 } from './workerRuntimeV2';

export type WorkerRuntimeReconciliationClassification =
  | 'legacy-lifecycle-run'
  | 'untracked-dispatch';

export interface WorkerRuntimeReconciliation {
  workerId: number;
  sessionName: string;
  lifecycleEpoch: string;
  runId: string;
  classification: WorkerRuntimeReconciliationClassification;
  outcome: WorkerRuntimeApplyOutcome;
}

export interface WorkerRuntimeReconcilerOptions {
  runtimeStore: WorkerRuntimeStateStoreV2;
  completionJobStore: CompletionJobStore;
  runtimeCoordinator: WorkerRuntimeCoordinator;
  eventSource?: HydraEventSource;
  now?: () => number;
}

const LEGACY_LIFECYCLE_REASONS = new Set([
  'worker-created',
  'worker-started',
  'worker-restored',
  'worker-creating',
  'worker-starting',
  'worker-restoring',
]);

/**
 * Conservatively repairs active runtime snapshots that have no durable
 * completion intent. It is intentionally invoked only by the attention
 * supervisor after that process acquires the shared producer lease.
 */
export class WorkerRuntimeReconciler {
  private readonly runtimeStore: WorkerRuntimeStateStoreV2;
  private readonly completionJobStore: CompletionJobStore;
  private readonly runtimeCoordinator: WorkerRuntimeCoordinator;
  private readonly eventSource: HydraEventSource;
  private readonly now: () => number;

  constructor(options: WorkerRuntimeReconcilerOptions) {
    this.runtimeStore = options.runtimeStore;
    this.completionJobStore = options.completionJobStore;
    this.runtimeCoordinator = options.runtimeCoordinator;
    this.eventSource = options.eventSource ?? 'session-manager';
    this.now = options.now ?? Date.now;
  }

  reconcile(workers: readonly WorkerInfo[]): WorkerRuntimeReconciliation[] {
    const reconciled: WorkerRuntimeReconciliation[] = [];
    for (const worker of workers) {
      if (worker.status === 'stopped') continue;
      const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
      const candidate = this.runtimeStore.get(worker.workerId);
      if (!candidate
        || candidate.state !== 'running'
        || candidate.lifecycleEpoch !== lifecycleEpoch
        || !candidate.runId) {
        continue;
      }
      const pending = this.completionJobStore.getPending(worker.workerId, lifecycleEpoch);
      if (pending?.runId === candidate.runId) continue;

      const classification = LEGACY_LIFECYCLE_REASONS.has(candidate.reason)
        ? 'legacy-lifecycle-run'
        : 'untracked-dispatch';
      const result = this.runtimeCoordinator.apply({
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: candidate.runId,
        revision: candidate.revision + 1,
        state: 'unknown',
        signalId: `runtime-reconcile:${worker.workerId}:${lifecycleEpoch}:${candidate.signalId}`,
        origin: 'lifecycle',
        reason: 'completion-tracking-unavailable',
        observedAt: new Date(this.now()).toISOString(),
        agent: worker.agent,
        workdir: worker.workdir,
      }, this.eventSource);
      const entry: WorkerRuntimeReconciliation = {
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch,
        runId: candidate.runId,
        classification,
        outcome: result.outcome,
      };
      reconciled.push(entry);
      logger.info('worker-runtime-reconciler.repair', 'Reconciled untracked worker runtime', { ...entry });
    }
    return reconciled;
  }
}
