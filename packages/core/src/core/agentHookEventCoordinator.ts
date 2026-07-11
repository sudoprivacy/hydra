import * as fs from 'fs';
import * as path from 'path';
import { CompletionJobStore } from './completionJobStore';
import { EventLog, type HydraEventSource } from './events';
import { hashText, redactText, truncateText } from './logRedaction';
import type { HydraNotificationV2 } from './notificationV2';
import { NotificationStore } from './notifications';
import { getHydraHome } from './path';
import type { WorkerInfo } from './sessionManager';
import { getWorkerLifecycleEpoch } from './workerIdentity';
import {
  classifyAgentHookEvent,
  type NormalizedAgentHookEvent,
} from './workerNeedsInputClassifier';
import {
  WorkerRuntimeCoordinator,
  type WorkerRuntimeApplyResult,
  type WorkerRuntimeIdentity,
} from './workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from './workerRuntimeState';
import { WorkerRuntimeStateStoreV2, type WorkerRuntimeSnapshotV2 } from './workerRuntimeV2';

export interface AgentHookEventInput {
  workerId: number;
  lifecycleEpoch: string;
  agent: string;
  eventName?: string;
  payload?: unknown;
}

export type AgentHookEventIgnoredReason =
  | 'worker-not-found'
  | 'stale-epoch'
  | 'agent-mismatch'
  | 'unsupported-event'
  | 'no-active-run'
  | 'not-waiting-for-input'
  | 'correlation-mismatch'
  | 'runtime-rejected';

export type AgentHookEventProcessResult =
  | {
    status: 'ignored';
    reason: AgentHookEventIgnoredReason;
    event?: NormalizedAgentHookEvent;
  }
  | {
    status: 'applied' | 'duplicate';
    event: NormalizedAgentHookEvent;
    runtime: WorkerRuntimeSnapshotV2;
    resolvedNotifications: number;
    notificationId?: string;
  };

export interface AgentHookEventCoordinatorOptions {
  resolveWorker: (workerId: number) => WorkerInfo | undefined;
  runtimeStore?: WorkerRuntimeStateStoreV2;
  compatibilityStore?: WorkerRuntimeStateStore;
  notificationStore?: NotificationStore;
  completionJobStore?: CompletionJobStore;
  eventLog?: EventLog;
  runtimeCoordinator?: WorkerRuntimeCoordinator;
  eventSource?: HydraEventSource;
  now?: () => number;
  lockPath?: string;
}

const MESSAGE_LIMIT = 600;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

export class AgentHookEventCoordinator {
  private readonly resolveWorker: (workerId: number) => WorkerInfo | undefined;
  private readonly runtimeStore: WorkerRuntimeStateStoreV2;
  private readonly notificationStore: NotificationStore;
  private readonly completionJobStore: CompletionJobStore;
  private readonly runtimeCoordinator: WorkerRuntimeCoordinator;
  private readonly eventSource: HydraEventSource;
  private readonly now: () => number;
  private readonly lockPath: string;

  constructor(options: AgentHookEventCoordinatorOptions) {
    this.resolveWorker = options.resolveWorker;
    this.runtimeStore = options.runtimeStore ?? new WorkerRuntimeStateStoreV2();
    const eventLog = options.eventLog ?? new EventLog();
    const compatibilityStore = options.compatibilityStore ?? new WorkerRuntimeStateStore();
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    this.completionJobStore = options.completionJobStore ?? new CompletionJobStore();
    this.runtimeCoordinator = options.runtimeCoordinator ?? new WorkerRuntimeCoordinator(
      workerId => this.resolveRuntimeIdentity(workerId),
      this.runtimeStore,
      compatibilityStore,
      eventLog,
    );
    this.eventSource = options.eventSource ?? 'hook';
    this.now = options.now ?? Date.now;
    this.lockPath = options.lockPath ?? path.join(getHydraHome(), 'agent-hook-events.lock');
  }

  process(input: AgentHookEventInput): AgentHookEventProcessResult {
    return this.withLock(() => this.processLocked(input));
  }

  private processLocked(input: AgentHookEventInput): AgentHookEventProcessResult {
    const worker = this.resolveWorker(input.workerId);
    if (!worker) return { status: 'ignored', reason: 'worker-not-found' };
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    if (lifecycleEpoch !== input.lifecycleEpoch) {
      return { status: 'ignored', reason: 'stale-epoch' };
    }
    if (worker.agent !== input.agent.trim()) {
      return { status: 'ignored', reason: 'agent-mismatch' };
    }

    const event = classifyAgentHookEvent({
      agent: input.agent,
      eventName: input.eventName,
      payload: input.payload,
    });
    if (!event) return { status: 'ignored', reason: 'unsupported-event' };

    switch (event.kind) {
      case 'needs-input':
        return this.processNeedsInput(worker, event);
      case 'input-resolved':
        return this.processInputResolved(worker, event);
      case 'runtime-error':
        return this.processRuntimeError(worker, event);
    }
  }

  private processNeedsInput(
    worker: WorkerInfo,
    event: Extract<NormalizedAgentHookEvent, { kind: 'needs-input' }>,
  ): AgentHookEventProcessResult {
    const runId = this.activeRunId(worker);
    if (!runId) return { status: 'ignored', reason: 'no-active-run', event };
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const signalId = this.signalId(worker, runId, event.kind, event.fingerprint);
    const occurrenceId = `agent-hook-occurrence:${hashText(signalId)}`;
    const runtimeResult = this.applyRuntime(
      worker,
      runId,
      'needs-input',
      event.reason,
      signalId,
      occurrenceId,
    );
    const runtime = this.acceptedRuntime(runtimeResult, signalId, runId);
    if (!runtime) return { status: 'ignored', reason: 'runtime-rejected', event };

    const notification = this.notificationStore.create({
      kind: 'needs-input',
      title: `Worker #${worker.workerId} needs input`,
      body: truncateText(
        redactText(`${event.title}\n\n${event.body}\n\nOpen the worker session to respond.`, MESSAGE_LIMIT),
        MESSAGE_LIMIT,
      ),
      targetSession: worker.copilotSessionName,
      sourceSession: worker.sessionName,
      dedupeKey: signalId,
      action: { type: 'open-session', session: worker.sessionName },
      context: this.notificationContext(worker),
      occurrenceId,
      lifecycleEpoch,
      runId,
      signalId,
      eventSource: this.eventSource,
    });
    return {
      status: runtimeResult.outcome === 'duplicate' ? 'duplicate' : 'applied',
      event,
      runtime,
      resolvedNotifications: 0,
      notificationId: notification.notification.id,
    };
  }

  private processInputResolved(
    worker: WorkerInfo,
    event: Extract<NormalizedAgentHookEvent, { kind: 'input-resolved' }>,
  ): AgentHookEventProcessResult {
    const current = this.currentRuntime(worker);
    if (!current?.runId || current.state !== 'needs-input') {
      return { status: 'ignored', reason: 'not-waiting-for-input', event };
    }
    const activeOccurrences = this.findNeedsInputOccurrences(worker, current.runId);
    const occurrences = event.correlationFingerprint
      ? this.findNeedsInputOccurrences(worker, current.runId, event.correlationFingerprint)
      : activeOccurrences;
    if (occurrences.length === 0 && event.correlationFingerprint) {
      return { status: 'ignored', reason: 'correlation-mismatch', event };
    }
    const resolvedIds = new Set(occurrences.map(occurrence => occurrence.id));
    const remainingOccurrences = activeOccurrences.filter(occurrence => !resolvedIds.has(occurrence.id));
    const signalId = this.signalId(worker, current.runId, event.kind, event.fingerprint);
    const runtimeResult = this.applyRuntime(
      worker,
      current.runId,
      remainingOccurrences.length > 0 ? 'needs-input' : 'running',
      event.reason,
      signalId,
      remainingOccurrences[0]?.occurrenceId,
    );
    const runtime = this.acceptedRuntime(runtimeResult, signalId, current.runId);
    if (!runtime) return { status: 'ignored', reason: 'runtime-rejected', event };
    const resolvedNotifications = this.resolveOccurrences(occurrences, event.reason);
    return {
      status: runtimeResult.outcome === 'duplicate' ? 'duplicate' : 'applied',
      event,
      runtime,
      resolvedNotifications,
    };
  }

  private processRuntimeError(
    worker: WorkerInfo,
    event: Extract<NormalizedAgentHookEvent, { kind: 'runtime-error' }>,
  ): AgentHookEventProcessResult {
    const runId = this.activeRunId(worker);
    if (!runId) return { status: 'ignored', reason: 'no-active-run', event };
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const signalId = this.signalId(worker, runId, event.kind, event.fingerprint);
    const occurrenceId = `agent-hook-occurrence:${hashText(signalId)}`;
    const runtimeResult = this.applyRuntime(
      worker,
      runId,
      'error',
      event.reason,
      signalId,
      occurrenceId,
    );
    const runtime = this.acceptedRuntime(runtimeResult, signalId, runId);
    if (!runtime) return { status: 'ignored', reason: 'runtime-rejected', event };

    this.completionJobStore.cancelPending(worker.workerId, 'agent-runtime-error', {
      lifecycleEpoch,
      runId,
    });
    const notification = this.notificationStore.create({
      kind: 'error',
      title: `Worker #${worker.workerId} stopped with an agent error`,
      body: truncateText(
        redactText(`${event.message}\n\nOpen the worker session to inspect the terminal output.`, MESSAGE_LIMIT),
        MESSAGE_LIMIT,
      ),
      targetSession: worker.copilotSessionName,
      sourceSession: worker.sessionName,
      dedupeKey: signalId,
      action: { type: 'open-session', session: worker.sessionName },
      context: this.notificationContext(worker),
      occurrenceId,
      lifecycleEpoch,
      runId,
      signalId,
      eventSource: this.eventSource,
    });
    const resolvedNotifications = this.resolveOccurrences(
      this.findNeedsInputOccurrences(worker, runId),
      'agent-runtime-error',
    );
    return {
      status: runtimeResult.outcome === 'duplicate' ? 'duplicate' : 'applied',
      event,
      runtime,
      resolvedNotifications,
      notificationId: notification.notification.id,
    };
  }

  private activeRunId(worker: WorkerInfo): string | undefined {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const current = this.currentRuntime(worker);
    if (current?.lifecycleEpoch === lifecycleEpoch
      && current.runId
      && (current.state === 'running' || current.state === 'needs-input')) {
      return current.runId;
    }
    return this.completionJobStore.getPending(worker.workerId, lifecycleEpoch)?.runId;
  }

  private applyRuntime(
    worker: WorkerInfo,
    runId: string,
    state: 'running' | 'needs-input' | 'error',
    reason: string,
    signalId: string,
    occurrenceId?: string,
  ): WorkerRuntimeApplyResult {
    const current = this.currentRuntime(worker);
    return this.runtimeCoordinator.apply({
      workerId: worker.workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      runId,
      revision: (current?.revision ?? -1) + 1,
      state,
      signalId,
      occurrenceId,
      origin: 'hook',
      reason,
      observedAt: this.timestamp(),
      agent: worker.agent,
      workdir: worker.workdir,
    }, this.eventSource);
  }

  private acceptedRuntime(
    result: WorkerRuntimeApplyResult,
    signalId: string,
    runId: string,
  ): WorkerRuntimeSnapshotV2 | undefined {
    const workerId = result.snapshot?.workerId ?? result.previous?.workerId;
    if (!workerId) return undefined;
    const runtime = this.runtimeStore.get(workerId);
    if (!runtime || runtime.runId !== runId || runtime.signalId !== signalId) return undefined;
    return result.outcome === 'applied' || result.outcome === 'duplicate' ? runtime : undefined;
  }

  private findNeedsInputOccurrences(
    worker: WorkerInfo,
    runId: string,
    correlationFingerprint?: string,
  ): HydraNotificationV2[] {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const expectedSignalId = correlationFingerprint
      ? this.signalId(worker, runId, 'needs-input', correlationFingerprint)
      : undefined;
    return this.notificationStore.listOccurrences('active')
      .filter(notification => notification.workerId === worker.workerId
        && notification.lifecycleEpoch === lifecycleEpoch
        && notification.runId === runId
        && notification.kind === 'needs-input'
        && (!expectedSignalId || notification.signalId === expectedSignalId));
  }

  private resolveOccurrences(occurrences: readonly HydraNotificationV2[], reason: string): number {
    let resolved = 0;
    for (const occurrence of occurrences) {
      if (this.notificationStore.resolve(occurrence.id, reason, this.eventSource).changed) resolved += 1;
    }
    return resolved;
  }

  private signalId(
    worker: WorkerInfo,
    runId: string,
    kind: NormalizedAgentHookEvent['kind'],
    fingerprint: string,
  ): string {
    return `${worker.agent}:${kind}:${hashText(`${worker.workerId}:${getWorkerLifecycleEpoch(worker)}:${runId}:${fingerprint}`)}`;
  }

  private currentRuntime(worker: WorkerInfo): WorkerRuntimeSnapshotV2 | undefined {
    return this.runtimeStore.get(worker.workerId);
  }

  private resolveRuntimeIdentity(workerId: number): WorkerRuntimeIdentity | undefined {
    const worker = this.resolveWorker(workerId);
    if (!worker) return undefined;
    return {
      workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      agent: worker.agent,
      workdir: worker.workdir,
    };
  }

  private notificationContext(worker: WorkerInfo) {
    return {
      workerId: worker.workerId,
      branch: worker.branch,
      workdir: worker.workdir,
      agent: worker.agent,
    };
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('Agent hook event clock returned a non-finite value');
    return new Date(Math.trunc(value)).toISOString();
  }

  private withLock<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockPath);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        this.removeStaleLock();
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for agent hook event lock at ${this.lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private removeStaleLock(): void {
    try {
      if (Date.now() - fs.statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
      }
    } catch {
      // The lock disappeared between checks.
    }
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
