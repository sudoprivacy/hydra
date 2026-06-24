import * as fs from 'fs';
import { getHydraSessionsFile, resolveAgentSessionFile } from './path';
import { logger } from './logger';
import {
  classifyCodexNeedsInputTranscriptText,
  classifyCodexRuntimeTranscriptText,
} from './workerNeedsInputClassifier';
import { publishWorkerNeedsInputNotification } from './workerAttentionNotifications';
import { readWorkerSessions } from './sessionStateReader';
import type { NotificationStore } from './notifications';
import type { WorkerInfo } from './sessionManager';
import { setWorkerRuntimeState, WorkerRuntimeStateStore } from './workerRuntimeState';

export interface WorkerNeedsInputMonitorOptions {
  readonly sessionsFile?: string;
  readonly pollIntervalMs?: number;
  readonly maxTranscriptBytes?: number;
  readonly store?: NotificationStore;
  readonly runtimeStateStore?: WorkerRuntimeStateStore;
}

export interface Disposable {
  dispose(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TRANSCRIPT_BYTES = 512 * 1024;

export class WorkerNeedsInputMonitor implements Disposable {
  private readonly sessionsFile: string;
  private readonly pollIntervalMs: number;
  private readonly maxTranscriptBytes: number;
  private readonly store?: NotificationStore;
  private readonly runtimeStateStore?: WorkerRuntimeStateStore;
  private disposed = false;
  private scanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WorkerNeedsInputMonitorOptions = {}) {
    this.sessionsFile = options.sessionsFile ?? getHydraSessionsFile();
    this.pollIntervalMs = Math.max(250, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.maxTranscriptBytes = Math.max(4096, Math.trunc(options.maxTranscriptBytes ?? DEFAULT_TRANSCRIPT_BYTES));
    this.store = options.store;
    this.runtimeStateStore = options.runtimeStateStore;
  }

  initialize(): void {
    if (this.scanTimer) {
      return;
    }
    this.disposed = false;
    this.scanOnce();
    this.scanTimer = setInterval(() => this.scanOnce(), this.pollIntervalMs);
  }

  dispose(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    this.disposed = true;
  }

  scanOnce(): void {
    if (this.disposed) {
      return;
    }

    for (const worker of readWorkerSessions(this.sessionsFile)) {
      if (worker.status === 'stopped' || worker.agent !== 'codex') {
        continue;
      }
      this.scanCodexWorker(worker);
    }
  }

  private scanCodexWorker(worker: WorkerInfo): void {
    const transcriptPath = resolveAgentSessionFile(
      worker.agent,
      worker.workdir,
      worker.sessionId,
      worker.agentSessionFile,
    );
    if (!transcriptPath) {
      return;
    }

    const transcript = readRecentTextFile(transcriptPath, this.maxTranscriptBytes);
    if (!transcript) {
      return;
    }

    const runtimeSignal = classifyCodexRuntimeTranscriptText(transcript);
    if (runtimeSignal && runtimeSignal.state !== 'needs-input') {
      try {
        setWorkerRuntimeState({
          sessionName: worker.sessionName,
          state: runtimeSignal.state,
          origin: 'codex-transcript',
          reason: runtimeSignal.reason,
          workerId: worker.workerId,
          agent: worker.agent,
          workdir: worker.workdir,
        }, 'hook', this.runtimeStateStore ?? new WorkerRuntimeStateStore());
      } catch (error) {
        logger.warn('worker-needs-input-monitor.runtime-state', 'Failed to update Codex worker runtime state', {
          sessionName: worker.sessionName,
          transcriptPath,
          state: runtimeSignal.state,
          reason: runtimeSignal.reason,
          error,
        });
      }
    }

    const signal = classifyCodexNeedsInputTranscriptText(transcript);
    if (!signal) {
      return;
    }

    const result = publishWorkerNeedsInputNotification(worker, signal, {
      eventSource: 'hook',
      store: this.store,
      runtimeStateStore: this.runtimeStateStore,
    });
    if (result.created) {
      logger.info('worker-needs-input-monitor.created', 'Published Codex needs-input notification', {
        sessionName: worker.sessionName,
        transcriptPath,
        reason: signal.reason,
      });
    }
  }
}

export function readRecentTextFile(filePath: string, maxBytes = DEFAULT_TRANSCRIPT_BYTES): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf-8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
