import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  createCodexTranscriptParserState,
  parseCodexTranscriptLines,
  type CodexTranscriptEvent,
} from './codexTranscriptParser';
import {
  CodexTranscriptCursorStore,
  type CodexTranscriptCursor,
  type CodexTranscriptIdentity,
} from './codexTranscriptCursorStore';
import { CompletionCoordinator } from './completionCoordinator';
import { CompletionJobStore } from './completionJobStore';
import { EventLog, type HydraEventSource } from './events';
import { hashText, redactText, truncateText } from './logRedaction';
import { logger } from './logger';
import { NotificationStore } from './notifications';
import { getHydraSessionsFile, resolveAgentSessionFile } from './path';
import { readWorkerSessionById, readWorkerSessions } from './sessionStateReader';
import type { WorkerInfo } from './sessionManager';
import {
  WorkerAttentionLeaseStore,
  type WorkerAttentionLease,
  type WorkerAttentionProducerKind,
} from './workerAttentionLease';
import { getWorkerLifecycleEpoch } from './workerIdentity';
import {
  WorkerRuntimeCoordinator,
  type WorkerRuntimeApplyResult,
  type WorkerRuntimeIdentity,
} from './workerRuntimeCoordinator';
import { WorkerRuntimeStateStore, type WorkerRuntimeState } from './workerRuntimeState';
import { WorkerRuntimeStateStoreV2, type WorkerRuntimeSnapshotV2 } from './workerRuntimeV2';

export interface WorkerAttentionSupervisorOptions {
  producerKind: WorkerAttentionProducerKind;
  ownerId?: string;
  sessionsFile?: string;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  leaseStore?: WorkerAttentionLeaseStore;
  cursorStore?: CodexTranscriptCursorStore;
  notificationStore?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
  runtimeV2Store?: WorkerRuntimeStateStoreV2;
  completionJobStore?: CompletionJobStore;
  eventLog?: EventLog;
  runtimeCoordinator?: WorkerRuntimeCoordinator;
  completionCoordinator?: CompletionCoordinator;
  now?: () => number;
}

export interface WorkerAttentionSupervisorScanResult {
  leaseAcquired: boolean;
  workersScanned: number;
  eventsProcessed: number;
}

export interface Disposable {
  dispose(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_NOTIFICATION_BODY = 600;

export class WorkerAttentionSupervisor implements Disposable {
  private readonly producerKind: WorkerAttentionProducerKind;
  private readonly ownerId: string;
  private readonly sessionsFile: string;
  private readonly pollIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly leaseStore: WorkerAttentionLeaseStore;
  private readonly cursorStore: CodexTranscriptCursorStore;
  private readonly notificationStore: NotificationStore;
  private readonly runtimeV2Store: WorkerRuntimeStateStoreV2;
  private readonly completionJobStore: CompletionJobStore;
  private readonly runtimeCoordinator: WorkerRuntimeCoordinator;
  private readonly completionCoordinator: CompletionCoordinator;
  private readonly eventSource: HydraEventSource;
  private readonly now: () => number;
  private lease: WorkerAttentionLease | undefined;
  private disposed = false;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private scanInFlight: Promise<void> | undefined;

  constructor(options: WorkerAttentionSupervisorOptions) {
    this.producerKind = options.producerKind;
    this.ownerId = options.ownerId
      ?? `${this.producerKind}:${process.pid}:${randomUUID()}`;
    this.sessionsFile = options.sessionsFile ?? getHydraSessionsFile();
    this.pollIntervalMs = normalizeInterval(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      60000,
      'poll interval',
    );
    this.leaseTtlMs = normalizeInterval(
      options.leaseTtlMs,
      this.pollIntervalMs * 4,
      2000,
      60000,
      'lease ttl',
    );
    this.now = options.now ?? Date.now;
    this.leaseStore = options.leaseStore ?? new WorkerAttentionLeaseStore(undefined, this.now);
    this.cursorStore = options.cursorStore ?? new CodexTranscriptCursorStore();
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    const runtimeStateStore = options.runtimeStateStore ?? new WorkerRuntimeStateStore();
    this.runtimeV2Store = options.runtimeV2Store ?? new WorkerRuntimeStateStoreV2();
    this.completionJobStore = options.completionJobStore ?? new CompletionJobStore(undefined, this.now);
    const eventLog = options.eventLog ?? new EventLog();
    this.eventSource = this.producerKind === 'extension' ? 'extension' : 'session-manager';
    this.runtimeCoordinator = options.runtimeCoordinator ?? new WorkerRuntimeCoordinator(
      workerId => this.resolveRuntimeIdentity(workerId),
      this.runtimeV2Store,
      runtimeStateStore,
      eventLog,
    );
    this.completionCoordinator = options.completionCoordinator ?? new CompletionCoordinator({
      resolveWorker: workerId => {
        const worker = this.resolveWorker(workerId);
        return worker ? { worker, lifecycleEpoch: getWorkerLifecycleEpoch(worker) } : undefined;
      },
      jobStore: this.completionJobStore,
      runtimeStore: this.runtimeV2Store,
      runtimeCoordinator: this.runtimeCoordinator,
      notificationStore: this.notificationStore,
      eventSource: this.eventSource,
      now: this.now,
    });
  }

  initialize(): void {
    if (this.scanTimer) return;
    this.disposed = false;
    this.scheduleScan();
    this.scanTimer = setInterval(() => this.scheduleScan(), this.pollIntervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    if (this.lease) {
      try {
        this.leaseStore.release(this.lease);
      } catch (error) {
        logger.warn('worker-attention-supervisor.lease-release', 'Failed to release attention supervisor lease', {
          producerKind: this.producerKind,
          ownerId: this.ownerId,
          error,
        });
      }
      this.lease = undefined;
    }
  }

  async scanOnce(): Promise<WorkerAttentionSupervisorScanResult> {
    if (this.disposed) return { leaseAcquired: false, workersScanned: 0, eventsProcessed: 0 };
    const lease = this.acquireOrRenewLease();
    if (!lease) return { leaseAcquired: false, workersScanned: 0, eventsProcessed: 0 };

    let workersScanned = 0;
    let eventsProcessed = 0;
    const workers = readWorkerSessions(this.sessionsFile)
      .filter(worker => worker.status !== 'stopped' && worker.agent === 'codex');
    let activeLease = lease;
    for (const worker of workers) {
      const renewed = this.leaseStore.renew(activeLease, this.leaseTtlMs);
      if (!renewed) {
        this.lease = undefined;
        break;
      }
      this.lease = renewed;
      activeLease = renewed;
      eventsProcessed += await this.scanCodexWorker(worker, activeLease);
      workersScanned += 1;
    }
    return { leaseAcquired: true, workersScanned, eventsProcessed };
  }

  private scheduleScan(): void {
    if (this.disposed || this.scanInFlight) return;
    this.scanInFlight = this.scanOnce()
      .then(() => undefined)
      .catch(error => {
        logger.warn('worker-attention-supervisor.scan', 'Worker attention supervisor scan failed', {
          producerKind: this.producerKind,
          ownerId: this.ownerId,
          error,
        });
      })
      .finally(() => {
        this.scanInFlight = undefined;
      });
  }

  private acquireOrRenewLease(): WorkerAttentionLease | undefined {
    if (this.lease) {
      const renewed = this.leaseStore.renew(this.lease, this.leaseTtlMs);
      if (renewed) {
        this.lease = renewed;
        return renewed;
      }
      this.lease = undefined;
    }
    const acquired = this.leaseStore.tryAcquire(
      this.producerKind,
      this.ownerId,
      this.leaseTtlMs,
    );
    this.lease = acquired;
    return acquired;
  }

  private async scanCodexWorker(worker: WorkerInfo, lease: WorkerAttentionLease): Promise<number> {
    const transcriptPath = resolveAgentSessionFile(
      worker.agent,
      worker.workdir,
      worker.sessionId,
      worker.agentSessionFile,
    );
    if (!transcriptPath) return 0;

    const stat = safeFileStat(transcriptPath);
    if (!stat) return 0;
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const transcript: CodexTranscriptIdentity = {
      path: path.resolve(transcriptPath),
      device: stat.dev,
      inode: stat.ino,
    };
    const stored = this.cursorStore.get(worker.workerId);
    if (!stored && stat.size === 0) {
      if (!this.leaseStore.isCurrent(lease)) {
        this.lease = undefined;
        return 0;
      }
      this.cursorStore.set(createCursor(
        worker.workerId,
        lifecycleEpoch,
        transcript,
        this.timestamp(),
      ));
      return 0;
    }
    const sameStoredTranscript = stored && sameTranscript(stored.transcript, transcript);
    const epochResetCursor = stored
      && stored.lifecycleEpoch !== lifecycleEpoch
      && sameStoredTranscript
      && stored.byteOffset <= stat.size
      ? createCursor(
        worker.workerId,
        lifecycleEpoch,
        transcript,
        this.timestamp(),
        stored.byteOffset,
      )
      : undefined;
    if (epochResetCursor) this.cursorStore.set(epochResetCursor);
    const cursor = epochResetCursor
      ?? (stored
        && stored.lifecycleEpoch === lifecycleEpoch
        && sameStoredTranscript
        && stored.byteOffset <= stat.size
        ? stored
        : createCursor(worker.workerId, lifecycleEpoch, transcript, this.timestamp()));
    if (cursor.byteOffset === stat.size) return 0;

    const delta = readFileRange(transcriptPath, cursor.byteOffset, stat.size);
    if (delta.length === 0) return 0;
    const pending = Buffer.from(cursor.pendingBytesBase64, 'base64');
    const split = splitJsonLines(Buffer.concat([pending, delta]));
    const parsed = parseCodexTranscriptLines(split.lines, cursor.parserState);
    const events = stored
      ? parsed.events
      : this.selectInitialRecoveryEvents(worker, parsed.events, parsed.state.pendingCallId);
    let activeLease = lease;
    for (const event of events) {
      const renewed = this.leaseStore.renew(activeLease, this.leaseTtlMs);
      if (!renewed) {
        this.lease = undefined;
        return 0;
      }
      this.lease = renewed;
      activeLease = renewed;
      await this.processCodexEvent(worker, event);
    }

    const finalLease = this.leaseStore.renew(activeLease, this.leaseTtlMs);
    if (!finalLease) {
      this.lease = undefined;
      return 0;
    }
    this.lease = finalLease;

    const nextCursor: CodexTranscriptCursor = {
      version: 1,
      workerId: worker.workerId,
      lifecycleEpoch,
      transcript,
      byteOffset: cursor.byteOffset + delta.length,
      pendingBytesBase64: split.pending.toString('base64'),
      parserState: parsed.state,
      updatedAt: this.timestamp(),
    };
    this.cursorStore.set(nextCursor);
    return events.length;
  }

  private async processCodexEvent(worker: WorkerInfo, event: CodexTranscriptEvent): Promise<void> {
    switch (event.kind) {
      case 'task-started':
        this.processTaskStarted(worker, event);
        return;
      case 'needs-input':
        this.processNeedsInput(worker, event);
        return;
      case 'input-resolved':
        this.processInputResolved(worker, event);
        return;
      case 'turn-complete':
        await this.processTurnComplete(worker, event);
        return;
      case 'turn-aborted':
        this.processTurnAborted(worker, event);
        return;
    }
  }

  private processTaskStarted(worker: WorkerInfo, event: CodexTranscriptEvent): void {
    const runId = this.resolveRunId(worker, event);
    this.applyRuntime(worker, event, 'running', 'task-started', runId);
  }

  private processNeedsInput(worker: WorkerInfo, event: CodexTranscriptEvent): void {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const runId = this.ensureActiveRun(worker, event);
    const signalId = this.signalId(worker, event);
    const occurrenceId = `codex-occurrence:${hashText(`${lifecycleEpoch}:${event.callId ?? event.nativeId}`)}`;
    const result = this.applyRuntime(
      worker,
      event,
      'needs-input',
      'request-user-input',
      runId,
      occurrenceId,
    );
    const authoritative = result.snapshot;
    if (result.outcome !== 'applied'
      && !(result.outcome === 'duplicate'
        && authoritative?.runId === runId
        && authoritative.signalId === signalId)) {
      return;
    }

    this.notificationStore.create({
      kind: 'needs-input',
      title: `Worker #${worker.workerId} needs input`,
      body: truncateText(
        redactText(event.question ?? 'Codex is waiting for input.'),
        MAX_NOTIFICATION_BODY,
      ),
      targetSession: worker.copilotSessionName,
      sourceSession: worker.sessionName,
      dedupeKey: signalId,
      action: { type: 'open-session', session: worker.sessionName },
      context: {
        workerId: worker.workerId,
        branch: worker.branch,
        workdir: worker.workdir,
        agent: worker.agent,
      },
      occurrenceId,
      lifecycleEpoch,
      runId,
      signalId,
      eventSource: this.eventSource,
    });
  }

  private processInputResolved(worker: WorkerInfo, event: CodexTranscriptEvent): void {
    const occurrence = this.findNeedsInputOccurrences(worker, event.callId)[0];
    const current = this.currentRuntime(worker);
    const runId = occurrence?.runId
      ?? (current?.lifecycleEpoch === getWorkerLifecycleEpoch(worker)
        && current.state === 'needs-input' ? current.runId : null);
    if (!runId) return;
    const result = this.applyRuntime(worker, event, 'running', 'input-resolved', runId);
    const runtimeAccepted = result.outcome === 'applied'
      || (result.outcome === 'duplicate' && result.snapshot?.runId === runId);
    if (occurrence && event.callId) {
      this.resolveNeedsInput(worker, runId, 'codex-function-call-output', event.callId);
    } else if (runtimeAccepted) {
      this.resolveNeedsInput(worker, runId, 'codex-function-call-output');
    }
  }

  private async processTurnComplete(worker: WorkerInfo, event: CodexTranscriptEvent): Promise<void> {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    let current = this.currentRuntime(worker);
    const currentRunId = current?.lifecycleEpoch === lifecycleEpoch
      && (current.state === 'running' || current.state === 'needs-input')
      ? current.runId
      : null;
    const pendingRunId = this.completionJobStore.getPending(worker.workerId, lifecycleEpoch)?.runId;
    const runId = currentRunId ?? pendingRunId;
    if (!runId) return;
    if (!currentRunId) {
      this.applyRuntime(
        worker,
        { ...event, kind: 'task-started', nativeId: `bootstrap:${event.nativeId}` },
        'running',
        'transcript-run-bootstrap',
        runId,
      );
      current = this.currentRuntime(worker);
    }
    const markerState = current?.lifecycleEpoch === getWorkerLifecycleEpoch(worker)
      ? current.state
      : 'running';
    const marker = this.applyRuntime(
      worker,
      event,
      markerState,
      'turn-complete-observed',
      runId,
    );
    const signalId = this.signalId(worker, event);
    if (marker.outcome !== 'applied'
      && !(marker.outcome === 'duplicate' && marker.snapshot?.signalId === signalId)) {
      const completedJob = this.completionJobStore.getForRun(worker.workerId, lifecycleEpoch, runId);
      if (marker.outcome === 'duplicate'
        && marker.snapshot?.runId === runId
        && marker.snapshot.state === 'idle'
        && completedJob?.status === 'fired') {
        this.resolveNeedsInput(worker, runId, 'codex-turn-complete');
      }
      return;
    }
    const completion = await this.completionCoordinator.complete({
      workerId: worker.workerId,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      observedAt: event.observedAt ?? this.timestamp(),
      sourceSequence: event.sourceSequence,
      origin: 'codex-transcript',
    });
    if (completion.outcome === 'completed' || completion.outcome === 'duplicate') {
      this.resolveNeedsInput(worker, runId, 'codex-turn-complete');
    } else {
      logger.warn('worker-attention-supervisor.completion', 'Codex completion signal was not applied', {
        workerId: worker.workerId,
        sessionName: worker.sessionName,
        lifecycleEpoch: getWorkerLifecycleEpoch(worker),
        outcome: completion.outcome,
      });
    }
  }

  private processTurnAborted(worker: WorkerInfo, event: CodexTranscriptEvent): void {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const currentSnapshot = this.currentRuntime(worker);
    const current = currentSnapshot?.lifecycleEpoch === lifecycleEpoch ? currentSnapshot : undefined;
    const occurrence = this.findNeedsInputOccurrences(worker, event.callId)[0];
    const runId = occurrence?.runId
      ?? current?.runId
      ?? this.completionJobStore.getPending(worker.workerId, lifecycleEpoch)?.runId;
    if (!runId) return;
    const result = this.applyRuntime(worker, event, 'idle', 'turn-aborted', runId);
    const signalId = this.signalId(worker, event);
    const runtimeAccepted = result.outcome === 'applied'
      || (result.outcome === 'duplicate' && result.snapshot?.signalId === signalId);
    const exactOccurrenceMatched = !!occurrence && !!event.callId;
    if (runtimeAccepted || exactOccurrenceMatched) {
      this.completionJobStore.cancelPending(worker.workerId, 'codex-turn-aborted', {
        lifecycleEpoch,
        runId,
      });
      this.resolveNeedsInput(
        worker,
        runId,
        'codex-turn-aborted',
        exactOccurrenceMatched ? event.callId : undefined,
      );
    }
  }

  private ensureActiveRun(worker: WorkerInfo, event: CodexTranscriptEvent): string {
    const current = this.currentRuntime(worker);
    if (current
      && current.lifecycleEpoch === getWorkerLifecycleEpoch(worker)
      && (current.state === 'running' || current.state === 'needs-input')
      && current.runId) {
      return current.runId;
    }
    const runId = this.resolveRunId(worker, event);
    this.applyRuntime(
      worker,
      { ...event, kind: 'task-started', nativeId: `bootstrap:${event.nativeId}` },
      'running',
      'transcript-run-bootstrap',
      runId,
    );
    return runId;
  }

  private resolveRunId(worker: WorkerInfo, event: CodexTranscriptEvent): string {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const current = this.currentRuntime(worker);
    if (current?.lifecycleEpoch === lifecycleEpoch && current.runId
      && (current.state === 'running' || current.state === 'needs-input')) {
      return current.runId;
    }
    const pending = this.completionJobStore.getPending(worker.workerId, lifecycleEpoch);
    if (pending) return pending.runId;
    return `codex-run:${hashText(`${worker.workerId}:${lifecycleEpoch}:${event.turnId ?? event.nativeId}`)}`;
  }

  private applyRuntime(
    worker: WorkerInfo,
    event: CodexTranscriptEvent,
    state: WorkerRuntimeState,
    reason: string,
    runId: string,
    occurrenceId?: string,
  ): WorkerRuntimeApplyResult {
    const current = this.runtimeV2Store.get(worker.workerId);
    return this.runtimeCoordinator.apply({
      workerId: worker.workerId,
      sessionName: worker.sessionName,
      lifecycleEpoch: getWorkerLifecycleEpoch(worker),
      runId,
      revision: (current?.revision ?? -1) + 1,
      state,
      signalId: this.signalId(worker, event),
      occurrenceId,
      sourceSequence: event.sourceSequence,
      origin: 'codex-transcript',
      reason,
      observedAt: event.observedAt ?? this.timestamp(),
      agent: worker.agent,
      workdir: worker.workdir,
    }, this.eventSource);
  }

  private findNeedsInputOccurrences(worker: WorkerInfo, callId?: string) {
    const lifecycleEpoch = getWorkerLifecycleEpoch(worker);
    const expectedSignalId = callId
      ? `codex:needs-input:${hashText(`${worker.workerId}:${lifecycleEpoch}:${callId}`)}`
      : undefined;
    return this.notificationStore.listOccurrences('active')
      .filter(notification => notification.workerId === worker.workerId
        && notification.lifecycleEpoch === lifecycleEpoch
        && notification.kind === 'needs-input'
        && (!expectedSignalId || notification.signalId === expectedSignalId));
  }

  private selectInitialRecoveryEvents(
    worker: WorkerInfo,
    events: readonly CodexTranscriptEvent[],
    pendingCallId: string | undefined,
  ): CodexTranscriptEvent[] {
    if (pendingCallId) {
      const pending = [...events].reverse().find(event =>
        event.kind === 'needs-input' && event.callId === pendingCallId,
      );
      return pending ? [pending] : [];
    }
    const resolution = [...events].reverse().find(event =>
      (event.kind === 'input-resolved' || event.kind === 'turn-aborted')
      && !!event.callId
      && this.findNeedsInputOccurrences(worker, event.callId).length > 0,
    );
    return resolution ? [resolution] : [];
  }

  private resolveNeedsInput(worker: WorkerInfo, runId: string, reason: string, callId?: string): void {
    for (const notification of this.findNeedsInputOccurrences(worker, callId)) {
      if (notification.runId === runId) {
        this.notificationStore.resolve(notification.id, reason, this.eventSource);
      }
    }
  }

  private currentRuntime(worker: WorkerInfo): WorkerRuntimeSnapshotV2 | undefined {
    return this.runtimeV2Store.get(worker.workerId);
  }

  private signalId(worker: WorkerInfo, event: CodexTranscriptEvent): string {
    return `codex:${event.kind}:${hashText(`${worker.workerId}:${getWorkerLifecycleEpoch(worker)}:${event.nativeId}`)}`;
  }

  private resolveWorker(workerId: number): WorkerInfo | undefined {
    return readWorkerSessionById(workerId, this.sessionsFile) ?? undefined;
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

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('Worker attention supervisor clock returned a non-finite value');
    return new Date(Math.trunc(value)).toISOString();
  }
}

function createCursor(
  workerId: number,
  lifecycleEpoch: string,
  transcript: CodexTranscriptIdentity,
  updatedAt: string,
  byteOffset = 0,
): CodexTranscriptCursor {
  return {
    version: 1,
    workerId,
    lifecycleEpoch,
    transcript,
    byteOffset,
    pendingBytesBase64: '',
    parserState: createCodexTranscriptParserState(),
    updatedAt,
  };
}

function normalizeInterval(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) {
    throw new Error(`Worker attention supervisor ${label} must be finite`);
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(candidate)));
}

function sameTranscript(a: CodexTranscriptIdentity, b: CodexTranscriptIdentity): boolean {
  return a.path === b.path && a.device === b.device && a.inode === b.inode;
}

function safeFileStat(filePath: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

function readFileRange(filePath: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function splitJsonLines(buffer: Buffer): { lines: string[]; pending: Buffer } {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue;
    const line = buffer.subarray(lineStart, index).toString('utf-8').replace(/\r$/, '');
    if (line.trim()) lines.push(line);
    lineStart = index + 1;
  }
  const tail = buffer.subarray(lineStart);
  if (tail.length > 0 && isCompleteJsonLine(tail)) {
    lines.push(tail.toString('utf-8').replace(/\r$/, ''));
    return { lines, pending: Buffer.alloc(0) };
  }
  return { lines, pending: Buffer.from(tail) };
}

function isCompleteJsonLine(buffer: Buffer): boolean {
  try {
    const value = JSON.parse(buffer.toString('utf-8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}
