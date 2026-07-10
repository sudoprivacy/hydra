// HydraAppService — the SERVER side of the seam.
//
// It receives `(op, payload)` from any transport and dispatches to the headless
// engine (`@hydra/core`: SessionManager / TmuxBackendCore / stores / EventLog +
// the DiffService). This is the ONE place the in-proc engine calls live, and it
// is *identical* in the future `hydrad` daemon — Fork B swaps the transport in
// front of it, never this class (FINAL.md §"A → B migration").
//
// The loopback HTTP/WS server that fronts this in M1 is NOT here yet; M0 proves
// the handler by driving it through `InProcessTransport`.
//
// ── verb → engine mapping (every op grounded in real code) ────────────────────
//  Op.listSessions          SessionManager.sync + WorkerRuntimeStateStore.get   (list.ts)
//  Op.createWorker          WorkerLifecycleService.create*                       (worker.ts)
//  Op.createCopilot         SessionManager.createCopilotAndFinalize             (copilot.ts)
//  Op.startSession          WorkerLifecycleService.startWorker / startCopilot
//  Op.stopWorker            WorkerLifecycleService.stopWorker
//  Op.deleteSession         WorkerLifecycleService.deleteWorker / deleteCopilot
//  Op.renameSession         WorkerLifecycleService.renameWorker / renameCopilot
//  Op.restoreSession        SessionManager.getArchived + WorkerLifecycleService.restoreWorker /
//                             restoreCopilotAndFinalize                          (archive.ts)
//  Op.getLogs               TmuxBackendCore.capturePane (+ getWorker/getCopilot) (worker.ts)
//  Op.sendMessage           WorkerLifecycleService / TmuxBackendCore             (worker.ts)
//  Op.broadcastToWorkers    WorkerLifecycleService.broadcastToWorkers            (worker send --all)
//  Op.listNotifications     NotificationStore.list
//  Op.markNotificationRead  NotificationStore.markRead
//  Op.clearNotifications    NotificationStore.clear
//  Op.getDiff               DiffService.getDiff (workdir from SessionManager)
//  Op.getFileSnapshot       DiffService.getFileSnapshot (path-constrained)
//  Op.getGitStatus          SessionManager.sync + git status --porcelain        (sidebar U:N)
//  Topic.events             EventLog.read (poll — EventBus push is M2)           (events.ts)
//  Topic.notifications      NotificationStateService.onDidChange
//  openTerminal             reserved in-process terminal seam; loopback attach
//                             is handled by TerminalBridge after ownership auth

import * as os from 'node:os';

import { TmuxBackendCore } from '@hydra/core/tmux';
import {
  isDirectoryWorker,
  SessionManager,
  type CopilotInfo,
  type WorkerInfo,
} from '@hydra/core/sessionManager';
import type { CopilotMode, MultiplexerBackendCore } from '@hydra/core/types';
import { WorkerRuntimeStateStore } from '@hydra/core/workerRuntimeState';
import { NotificationStore } from '@hydra/core/notifications';
import { NotificationStateService } from '@hydra/core/notificationStateService';
import { EventLog, type HydraEventSource } from '@hydra/core/events';
import { resolveAgentSessionFile, expandAndResolvePath } from '@hydra/core/path';
import { getRepoRootFromPath, localBranchExists, fetchOriginRequired } from '@hydra/core/git';
import { resolveRepoInput } from '@hydra/core/repoRegistry';
import { getHydraGlobalDefaultAgent } from '@hydra/core/hydraGlobalConfig';
import { DiffService } from '@hydra/core/diff';
import { getCopilotOnboardingPrompt } from '@hydra/core/copilotOnboarding';
import { WorkerLifecycleService } from '@hydra/core/workerLifecycleService';

import { collectCodeWorkerGitStatus } from './gitStatus';

import {
  Op,
  Topic,
  type HydraAppService as HydraAppServiceApi,
  type BroadcastPayload,
  type BroadcastResult,
  type CreateCopilotInput,
  type CreateCopilotResult,
  type CreateWorkerInput,
  type CreateWorkerResult,
  type DeleteSessionPayload,
  type DiffSummary,
  type EventSubscribeInput,
  type FileSnapshot,
  type FileSnapshotInput,
  type GetDiffPayload,
  type GetLogsPayload,
  type GitStatusMap,
  type HydraEvent,
  type HydraSessionList,
  type LogResult,
  type MarkNotificationReadPayload,
  type NotificationClearFilters,
  type NotificationClearResult,
  type NotificationListFilters,
  type NotificationListResult,
  type NotificationReadResult,
  type NotificationSnapshot,
  type RenameSessionPayload,
  type RestoreSessionPayload,
  type SendMessagePayload,
  type SendResult,
  type SessionListCopilot,
  type SessionListWorker,
  type SessionResult,
  type StartSessionPayload,
  type StopWorkerPayload,
  type TerminalAttachInput,
  type TerminalChannel,
  type WorkerRuntimeCliSnapshot,
} from '@hydra/protocol';

const DEFAULT_LOG_LINES = 50;
const EVENT_POLL_INTERVAL_MS = 250;

export interface HydraAppServiceOptions {
  /** Multiplexer backend. Defaults to the real tmux backend. Tests inject a fake. */
  backend?: MultiplexerBackendCore;
  sessionManager?: SessionManager;
  notificationStore?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
  eventLog?: EventLog;
  diffService?: DiffService;
  /**
   * Source stamped on sidecar-originated notification events. Must be a value
   * from the fixed `HydraEventSource` enum (contract). The sidecar hosts the
   * engine, so 'session-manager' is the truthful default.
   */
  notificationEventSource?: HydraEventSource;
}

export class HydraAppService implements HydraAppServiceApi {
  private readonly backend: MultiplexerBackendCore;
  private readonly sessionManager: SessionManager;
  private readonly notificationStore: NotificationStore;
  private readonly runtimeStateStore: WorkerRuntimeStateStore;
  private readonly workerLifecycle: WorkerLifecycleService;
  private readonly eventLog: EventLog;
  private readonly diffService: DiffService;
  private readonly notificationEventSource: HydraEventSource;

  constructor(options: HydraAppServiceOptions = {}) {
    this.backend = options.backend ?? new TmuxBackendCore();
    this.sessionManager = options.sessionManager ?? new SessionManager(this.backend);
    this.notificationStore = options.notificationStore ?? new NotificationStore();
    this.runtimeStateStore = options.runtimeStateStore ?? new WorkerRuntimeStateStore();
    this.eventLog = options.eventLog ?? new EventLog();
    this.diffService = options.diffService ?? new DiffService();
    this.notificationEventSource = options.notificationEventSource ?? 'session-manager';
    this.workerLifecycle = new WorkerLifecycleService({
      backend: this.backend,
      sessionManager: this.sessionManager,
      notificationStore: this.notificationStore,
      runtimeStateStore: this.runtimeStateStore,
      eventLog: this.eventLog,
      eventSource: this.notificationEventSource,
    });
  }

  // ── transport waist (3 methods) + sidecar-internal terminal authorization ──

  // `auth` is part of the HydraAppService contract but ignored in-process; it is
  // omitted here (optional params may be dropped by an implementer) and wired in
  // when the loopback server / hydrad enforce it. See FINAL.md §"Security".
  async request<TReq, TRes>(op: string, payload: TReq): Promise<TRes> {
    return (await this.dispatch(op, payload)) as TRes;
  }

  stream<TReq, TEvt>(topic: string, payload: TReq): AsyncIterable<TEvt> {
    switch (topic) {
      case Topic.events:
        return this.subscribeEvents((payload ?? {}) as EventSubscribeInput) as AsyncIterable<TEvt>;
      case Topic.notifications:
        return this.subscribeNotifications() as AsyncIterable<TEvt>;
      default:
        throw new Error(`HydraAppService: unknown stream topic "${topic}"`);
    }
  }

  openTerminal(input: TerminalAttachInput): TerminalChannel {
    // Loopback terminal attach is implemented by TerminalBridge. The in-process
    // transport keeps the frozen terminal method but has no PTY bridge.
    throw new Error(
      `attachTerminal (node-pty ⇄ tmux bridge) is implemented in milestone M3; requested session "${input.session}"`,
    );
  }

  async authorizeTerminal(input: TerminalAttachInput): Promise<void> {
    await this.sessionManager.assertHydraSessionOwnership(input.session);
  }

  // ── request dispatch ──

  private async dispatch(op: string, payload: unknown): Promise<unknown> {
    switch (op) {
      case Op.listSessions:
        return this.listSessions();
      case Op.createWorker:
        return this.createWorker(payload as CreateWorkerInput);
      case Op.createCopilot:
        return this.createCopilot(payload as CreateCopilotInput);
      case Op.startSession:
        return this.startSession(payload as StartSessionPayload);
      case Op.stopWorker:
        return this.stopWorker(payload as StopWorkerPayload);
      case Op.deleteSession:
        return this.deleteSession(payload as DeleteSessionPayload);
      case Op.renameSession:
        return this.renameSession(payload as RenameSessionPayload);
      case Op.restoreSession:
        return this.restoreSession(payload as RestoreSessionPayload);
      case Op.getLogs:
        return this.getLogs(payload as GetLogsPayload);
      case Op.sendMessage:
        return this.sendMessage(payload as SendMessagePayload);
      case Op.broadcastToWorkers:
        return this.broadcastToWorkers(payload as BroadcastPayload);
      case Op.listNotifications:
        return this.listNotifications(payload as NotificationListFilters);
      case Op.markNotificationRead:
        return this.markNotificationRead(payload as MarkNotificationReadPayload);
      case Op.clearNotifications:
        return this.clearNotifications(payload as NotificationClearFilters);
      case Op.getDiff:
        return this.getDiff(payload as GetDiffPayload);
      case Op.getFileSnapshot:
        return this.getFileSnapshot(payload as FileSnapshotInput);
      case Op.getGitStatus:
        return this.listGitStatus();
      default:
        throw new Error(`HydraAppService: unknown op "${op}"`);
    }
  }

  // ── handlers (each mirrors its CLI command's engine calls + JSON fields) ──

  /** SessionManager.sync + WorkerRuntimeStateStore.get — mirrors `hydra list`. */
  private async listSessions(): Promise<HydraSessionList> {
    const state = await this.sessionManager.sync();

    const copilots = Object.values(state.copilots)
      .sort((a, b) => (a.sessionName || a.tmuxSession).localeCompare(b.sessionName || b.tmuxSession))
      .map((c): SessionListCopilot => ({
        name: c.displayName || c.sessionName || c.tmuxSession,
        session: c.sessionName || c.tmuxSession,
        agent: c.agent,
        mode: c.copilotMode,
        status: c.status,
        attached: c.attached,
        workdir: c.workdir || null,
        sessionId: c.sessionId,
        sessionFile: resolveAgentSessionFile(c.agent, c.workdir, c.sessionId, c.agentSessionFile),
        agentSessionId: c.sessionId,
      }));

    const workers = Object.values(state.workers).map((w): SessionListWorker => ({
      number: w.workerId,
      name: w.displayName || w.slug || w.sessionName || w.tmuxSession,
      type: isDirectoryWorker(w) ? 'task' : 'code',
      session: w.sessionName || w.tmuxSession,
      repo: w.repo || null,
      branch: w.branch || null,
      agent: w.agent,
      status: w.status,
      runtimeState: formatWorkerRuntimeState(w.status, this.runtimeStateStore.get(w.sessionName || w.tmuxSession)),
      attached: w.attached,
      workdir: w.workdir || null,
      managedWorkdir: w.managedWorkdir === true,
      copilotSessionName: w.copilotSessionName || null,
      sessionId: w.sessionId,
      sessionFile: resolveAgentSessionFile(w.agent, w.workdir, w.sessionId, w.agentSessionFile),
      agentSessionId: w.sessionId,
    }));

    return { copilots, workers, count: copilots.length + workers.length };
  }

  /** WorkerLifecycleService.create* — mirrors `hydra worker create`. */
  private async createWorker(input: CreateWorkerInput): Promise<CreateWorkerResult> {
    const taskModeRequested = Boolean(input.dir) || input.temp === true;
    if (input.repo && taskModeRequested) {
      throw new Error('--repo cannot be used with --dir or --temp.');
    }
    if (input.dir && input.temp) {
      throw new Error('--dir and --temp are mutually exclusive.');
    }

    const agentType = input.agent || getHydraGlobalDefaultAgent().agent;

    if (input.repo) {
      if (!input.branch?.trim()) {
        throw new Error('--branch is required when using --repo.');
      }
      const { path: repoPath, isManaged } = resolveRepoInput(input.repo);
      const repoRoot = await getRepoRootFromPath(repoPath);
      const branch = input.branch.trim();
      const branchExisted = await localBranchExists(repoRoot, branch);

      const result = await this.workerLifecycle.createWorker({
        repoRoot,
        branchName: branch,
        agentType,
        baseBranchOverride: input.base,
        task: input.task,
        taskFile: input.taskFile,
        copilotSessionName: input.copilot,
        notifyCopilot: input.notifyCopilot ?? true,
        fetchMode: isManaged ? 'required' : 'best-effort',
      });
      await result.postCreatePromise;
      return this.toCreateWorkerResult(result.workerInfo, branchExisted ? 'exists' : 'created');
    }

    if (taskModeRequested) {
      if (input.temp) {
        const name = input.name?.trim();
        if (!name) {
          throw new Error('--name is required when using --temp.');
        }
        const result = await this.workerLifecycle.createDirectoryWorker({
          managedWorkdir: true, name, agentType,
          task: input.task, taskFile: input.taskFile,
          copilotSessionName: input.copilot, notifyCopilot: input.notifyCopilot ?? true,
        });
        await result.postCreatePromise;
        return this.toCreateWorkerResult(result.workerInfo, 'created');
      }

      const workdir = expandAndResolvePath(input.dir!);
      const result = await this.workerLifecycle.createDirectoryWorker({
        workdir, name: input.name?.trim(), managedWorkdir: false, agentType,
        task: input.task, taskFile: input.taskFile,
        copilotSessionName: input.copilot, notifyCopilot: input.notifyCopilot ?? true,
      });
      await result.postCreatePromise;
      return this.toCreateWorkerResult(result.workerInfo, 'created');
    }

    throw new Error(
      'createWorker requires --repo (with --branch) for a code worker, or --dir / --temp for a task worker.',
    );
  }

  /** SessionManager.createCopilotAndFinalize — mirrors `hydra copilot create`. */
  private async createCopilot(input: CreateCopilotInput): Promise<CreateCopilotResult> {
    const agentType = input.agent || getHydraGlobalDefaultAgent().agent;
    const copilotMode = resolveCopilotMode(input);
    const defaultSessionName = copilotMode === 'plan'
      ? `hydra-plan-${agentType}`
      : `hydra-copilot-${agentType}`;
    const sessionName = this.backend.sanitizeSessionName(input.session || input.name || defaultSessionName);

    let workdir: string;
    if (input.repo) {
      const resolved = resolveRepoInput(input.repo);
      workdir = resolved.path;
      if (resolved.isManaged) {
        await fetchOriginRequired(workdir);
      }
    } else {
      workdir = expandAndResolvePath(input.workdir ?? os.homedir());
    }

    const copilot = await this.sessionManager.createCopilotAndFinalize({
      workdir, agentType, copilotMode, name: input.name, sessionName,
    });
    await this.sendCopilotOnboarding(copilot.sessionName, copilot.copilotMode);

    return {
      status: 'created',
      session: copilot.sessionName,
      agent: copilot.agent,
      mode: copilot.copilotMode,
      workdir: copilot.workdir,
      agentSessionId: copilot.sessionId,
    };
  }

  private async sendCopilotOnboarding(sessionName: string, copilotMode: CopilotMode): Promise<void> {
    try {
      await this.backend.sendMessage(sessionName, getCopilotOnboardingPrompt(copilotMode));
    } catch {
      // Best effort: the copilot itself is already created and ready.
    }
  }

  /** WorkerLifecycleService.startWorker / SessionManager.startCopilot. */
  private async startSession(payload: StartSessionPayload): Promise<SessionResult> {
    if (payload.kind === 'worker') {
      const { workerInfo, postCreatePromise } = await this.workerLifecycle.startWorker(
        payload.session, payload.options?.agent, payload.options?.agentCommand,
      );
      await postCreatePromise;
      return {
        status: 'started', kind: 'worker', session: workerInfo.sessionName,
        agent: workerInfo.agent, workdir: workerInfo.workdir,
      };
    }
    const { copilotInfo, postCreatePromise } = await this.sessionManager.startCopilot(payload.session);
    await postCreatePromise;
    return {
      status: 'started', kind: 'copilot', session: copilotInfo.sessionName,
      agent: copilotInfo.agent, workdir: copilotInfo.workdir,
    };
  }

  /** WorkerLifecycleService.stopWorker. */
  private async stopWorker(payload: StopWorkerPayload): Promise<SessionResult> {
    await this.workerLifecycle.stopWorker(payload.session);
    return { status: 'stopped', kind: 'worker', session: payload.session };
  }

  /** WorkerLifecycleService.deleteWorker / SessionManager.deleteCopilot. */
  private async deleteSession(payload: DeleteSessionPayload): Promise<SessionResult> {
    if (payload.kind === 'worker') {
      const deleteFiles = payload.options?.deleteFiles === true;
      await this.workerLifecycle.deleteWorker(payload.session, { deleteFiles });
      return { status: 'deleted', kind: 'worker', session: payload.session, deleteFiles };
    }
    await this.sessionManager.deleteCopilot(payload.session);
    return { status: 'deleted', kind: 'copilot', session: payload.session };
  }

  /** WorkerLifecycleService.renameWorker / SessionManager.renameCopilot. */
  private async renameSession(payload: RenameSessionPayload): Promise<SessionResult> {
    if (payload.kind === 'worker') {
      const worker = await this.workerLifecycle.renameWorker(payload.session, payload.name);
      return {
        status: 'renamed', kind: 'worker', oldSession: payload.session,
        session: worker.sessionName, branch: worker.branch, workdir: worker.workdir,
      };
    }
    const copilot = await this.sessionManager.renameCopilot(payload.session, payload.name);
    return {
      status: 'renamed', kind: 'copilot', oldSession: payload.session,
      session: copilot.sessionName, newSession: copilot.sessionName,
    };
  }

  /** SessionManager.getArchived + WorkerLifecycleService.restoreWorker / restoreCopilotAndFinalize. */
  private async restoreSession(payload: RestoreSessionPayload): Promise<SessionResult> {
    const entry = this.sessionManager.getArchived(payload.session);
    if (!entry) {
      throw new Error(`Archived session "${payload.session}" not found`);
    }

    if (entry.type === 'worker') {
      const { workerInfo, postCreatePromise } = await this.workerLifecycle.restoreWorker(payload.session);
      await postCreatePromise;
      return {
        status: 'restored', kind: 'worker', type: 'worker',
        workerType: isDirectoryWorker(workerInfo) ? 'task' : 'code',
        session: workerInfo.sessionName, branch: workerInfo.branch,
        name: workerInfo.displayName || workerInfo.slug, agent: workerInfo.agent,
        workdir: workerInfo.workdir, agentSessionId: workerInfo.sessionId,
      };
    }

    const copilot = await this.sessionManager.restoreCopilotAndFinalize(payload.session);
    return {
      status: 'restored', kind: 'copilot', type: 'copilot',
      session: copilot.sessionName, agent: copilot.agent, mode: copilot.copilotMode,
      workdir: copilot.workdir, agentSessionId: copilot.sessionId,
    };
  }

  /** TmuxBackendCore.capturePane (+ getWorker/getCopilot) — mirrors `worker logs`. */
  private async getLogs(payload: GetLogsPayload): Promise<LogResult> {
    const lines = payload.lines ?? DEFAULT_LOG_LINES;
    if (!Number.isInteger(lines) || lines <= 0) {
      throw new Error('lines must be a positive integer');
    }
    const [output, entity] = await Promise.all([
      this.backend.capturePane(payload.session, lines),
      payload.kind === 'worker'
        ? this.sessionManager.getWorker(payload.session)
        : this.sessionManager.getCopilot(payload.session),
    ]);
    const sessionFile = entity
      ? resolveAgentSessionFile(entity.agent, entity.workdir, entity.sessionId, entity.agentSessionFile)
      : null;
    return { session: payload.session, lines, output, sessionId: entity?.sessionId ?? null, sessionFile };
  }

  /** WorkerLifecycleService / TmuxBackendCore.sendMessage — mirrors `worker/copilot send`. */
  private async sendMessage(payload: SendMessagePayload): Promise<SendResult> {
    if (payload.kind === 'worker') {
      await this.workerLifecycle.sendWorkerMessage(payload.session, payload.message);
    } else {
      await this.backend.sendMessage(payload.session, payload.message);
    }
    return { status: 'sent', session: payload.session, message: payload.message };
  }

  /** WorkerLifecycleService.broadcastToWorkers — mirrors `worker send --all`. */
  private async broadcastToWorkers(payload: BroadcastPayload): Promise<BroadcastResult> {
    const result = await this.workerLifecycle.broadcastToWorkers(payload.message);
    const sent = result.workers.map(worker => worker.sessionName);
    return { status: 'sent', sessions: sent, message: payload.message };
  }

  /** NotificationStore.list. */
  private async listNotifications(filters: NotificationListFilters): Promise<NotificationListResult> {
    return this.notificationStore.list(filters ?? {});
  }

  /** NotificationStore.markRead. */
  private async markNotificationRead(payload: MarkNotificationReadPayload): Promise<NotificationReadResult> {
    return this.notificationStore.markRead(payload.id, this.notificationEventSource);
  }

  /** NotificationStore.clear. */
  private async clearNotifications(filters: NotificationClearFilters): Promise<NotificationClearResult> {
    return this.notificationStore.clear(filters ?? {}, this.notificationEventSource);
  }

  /** DiffService.getDiff over the trusted session workdir. */
  private async getDiff(payload: GetDiffPayload): Promise<DiffSummary> {
    const workdir = await this.resolveSessionWorkdir(payload.session);
    const result = await this.diffService.getDiff(workdir);
    return {
      session: payload.session,
      workdir,
      baseRef: result.baseRef,
      baseCommit: result.baseCommit,
      branch: result.branch,
      changes: result.changes,
      count: result.changes.length,
    };
  }

  /** DiffService.getFileSnapshot — path-constrained to the session workdir. */
  private async getFileSnapshot(input: FileSnapshotInput): Promise<FileSnapshot> {
    const workdir = await this.resolveSessionWorkdir(input.session);
    const snapshot = await this.diffService.getFileSnapshot(workdir, input.path, input.side ?? 'current');
    return {
      session: input.session,
      path: snapshot.path,
      side: snapshot.side,
      ref: snapshot.ref,
      content: snapshot.content,
      exists: snapshot.exists,
    };
  }

  /**
   * SessionManager.sync + `git status --porcelain` per code worker — the change
   * counts that back the sidebar `U:N`. App-internal (not a CLI verb): batched
   * into one sync + concurrent git probes, skipping task workers and copilots.
   */
  private async listGitStatus(): Promise<GitStatusMap> {
    const state = await this.sessionManager.sync();
    return collectCodeWorkerGitStatus(Object.values(state.workers));
  }

  // ── streams ──

  /**
   * EventLog.read — drain the backlog after `after`, then poll for new events.
   * This is the M0 compatibility poller (mirrors `hydra events --follow`); the
   * in-proc EventBus push replaces the poll in M2. Consumers stop by breaking
   * the `for await`, which returns the generator and clears the timer.
   */
  private async *subscribeEvents(input: EventSubscribeInput): AsyncGenerator<HydraEvent> {
    let after = input.after ?? 0;
    for (;;) {
      const events = this.eventLog.read({ after, tolerateIncompleteTail: true });
      for (const event of events) {
        after = event.seq;
        yield event;
      }
      await sleep(EVENT_POLL_INTERVAL_MS);
    }
  }

  /**
   * NotificationStateService — yield the current snapshot, then push each
   * `onDidChange` delta. Snapshot + delta, never inferred from terminal text
   * (FINAL.md §"Event model"). The service (and its watchers) is disposed when
   * the consumer stops the iteration.
   */
  private async *subscribeNotifications(): AsyncGenerator<NotificationSnapshot> {
    const service = new NotificationStateService();
    service.initialize();
    const queue: NotificationSnapshot[] = [];
    let notify: (() => void) | undefined;
    const subscription = service.onDidChange((snapshot) => {
      queue.push(snapshot);
      notify?.();
      notify = undefined;
    });
    try {
      yield service.getSnapshot();
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { notify = resolve; });
        }
        while (queue.length > 0) {
          yield queue.shift() as NotificationSnapshot;
        }
      }
    } finally {
      subscription.dispose();
      service.dispose();
    }
  }

  // ── shared helpers ──

  private toCreateWorkerResult(workerInfo: WorkerInfo, status: 'created' | 'exists'): CreateWorkerResult {
    return {
      status,
      type: isDirectoryWorker(workerInfo) ? 'task' : 'code',
      session: workerInfo.sessionName,
      branch: workerInfo.branch,
      name: workerInfo.displayName || workerInfo.slug,
      agent: workerInfo.agent,
      workdir: workerInfo.workdir,
      managedWorkdir: workerInfo.managedWorkdir === true,
    };
  }

  /**
   * The trusted workdir for a session — the anchor for getDiff/getFileSnapshot.
   * Comes from engine state (never a renderer payload), which is what makes the
   * path constraint in DiffService safe.
   */
  private async resolveSessionWorkdir(session: string): Promise<string> {
    const worker: WorkerInfo | undefined = await this.sessionManager.getWorker(session);
    if (worker?.workdir) {
      return worker.workdir;
    }
    const copilot: CopilotInfo | undefined = await this.sessionManager.getCopilot(session);
    if (copilot?.workdir) {
      return copilot.workdir;
    }
    throw new Error(`Session "${session}" not found`);
  }

}

// ── module-local helpers (mirror list.ts / copilot.ts) ──

function formatWorkerRuntimeState(
  workerStatus: string,
  snapshot: ReturnType<WorkerRuntimeStateStore['get']>,
): WorkerRuntimeCliSnapshot {
  if (workerStatus === 'stopped') {
    return { state: 'unknown', updatedAt: null, origin: 'session-manager', reason: 'session-stopped' };
  }
  if (!snapshot) {
    return { state: 'unknown', updatedAt: null, origin: 'session-manager', reason: 'no-runtime-signal' };
  }
  return {
    state: snapshot.state,
    updatedAt: snapshot.updatedAt,
    origin: snapshot.origin,
    reason: snapshot.reason,
    notificationId: snapshot.notificationId,
  };
}

function resolveCopilotMode(input: { mode?: CopilotMode; plan?: boolean }): CopilotMode {
  if (input.plan) {
    return 'plan';
  }
  return input.mode === 'plan' ? 'plan' : 'normal';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
