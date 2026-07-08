import * as fs from 'fs';
import {
  cloneWorkerRuntimeSnapshot,
  getHydraWorkerRuntimeStateFile,
  WorkerRuntimeStateStore,
  type WorkerRuntimeSnapshot,
} from './workerRuntimeState';
import { logger } from './logger';

export interface Disposable {
  dispose(): void;
}

export interface WorkerRuntimeStateSource {
  getWorkerRuntimeState(sessionName: string): WorkerRuntimeSnapshot | undefined;
}

export interface WorkerRuntimeStateServiceOptions {
  readonly filePath?: string;
  readonly pollIntervalMs?: number;
  readonly store?: WorkerRuntimeStateStore;
}

type WorkerRuntimeStateListener = () => void;

const DEFAULT_POLL_INTERVAL_MS = 1000;

export class WorkerRuntimeStateService implements Disposable, WorkerRuntimeStateSource {
  private readonly filePath: string;
  private readonly pollIntervalMs: number;
  private readonly store: WorkerRuntimeStateStore;
  private readonly listeners = new Set<WorkerRuntimeStateListener>();
  private snapshots = new Map<string, WorkerRuntimeSnapshot>();
  private initialized = false;
  private disposed = false;
  private lastFileSignature = 'missing';
  private readonly fileListener = (current: fs.Stats, previous: fs.Stats) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
      return;
    }
    this.handleFileChange();
  };

  constructor(options: WorkerRuntimeStateServiceOptions = {}) {
    this.filePath = options.filePath ?? getHydraWorkerRuntimeStateFile();
    this.pollIntervalMs = Math.max(50, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.store = options.store ?? new WorkerRuntimeStateStore(this.filePath);
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.disposed = false;
    this.lastFileSignature = getFileSignature(this.filePath);
    this.reloadNow({ emit: false, reason: 'initialize' });
    fs.watchFile(this.filePath, { interval: this.pollIntervalMs }, this.fileListener);
  }

  dispose(): void {
    fs.unwatchFile(this.filePath, this.fileListener);
    this.listeners.clear();
    this.initialized = false;
    this.disposed = true;
  }

  onDidChange(listener: WorkerRuntimeStateListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  getWorkerRuntimeState(sessionName: string): WorkerRuntimeSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionName);
    return snapshot ? cloneWorkerRuntimeSnapshot(snapshot) : undefined;
  }

  private handleFileChange(): void {
    const signature = getFileSignature(this.filePath);
    if (signature === this.lastFileSignature) {
      return;
    }
    this.lastFileSignature = signature;
    this.reloadNow({ emit: true, reason: 'file-change' });
  }

  private reloadNow(options: { emit: boolean; reason: string }): void {
    if (this.disposed) {
      return;
    }

    const previousRevision = buildRevision(this.snapshots);
    let snapshots: WorkerRuntimeSnapshot[];
    try {
      snapshots = this.store.list();
    } catch (error) {
      logger.warn('worker-runtime-state-service.reload', 'Failed to reload worker runtime state', {
        reason: options.reason,
        error,
      });
      return;
    }

    this.snapshots = new Map(snapshots.map(snapshot => [snapshot.sessionName, snapshot]));
    const revision = buildRevision(this.snapshots);
    if (options.emit && revision !== previousRevision) {
      this.emitChange();
    }
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function buildRevision(snapshots: ReadonlyMap<string, WorkerRuntimeSnapshot>): string {
  return [...snapshots.values()]
    .sort((a, b) => a.sessionName.localeCompare(b.sessionName))
    .map(snapshot => [
      snapshot.sessionName,
      snapshot.state,
      snapshot.updatedAt,
      snapshot.origin,
      snapshot.reason || '',
      snapshot.notificationId || '',
    ].join(':'))
    .join('|');
}

function getFileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}
