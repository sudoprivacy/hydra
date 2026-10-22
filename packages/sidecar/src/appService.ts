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
//  Op.listWorkerRuntimeV2   WorkerRuntimeStateStoreV2.list
//  Op.createWorker          WorkerLifecycleService.create*                       (worker.ts)
//  Op.createCopilot         SessionManager.createCopilot + background finalize  (copilot.ts)
//  Op.startSession          WorkerLifecycleService.startWorker / startCopilot
//  Op.stopWorker            WorkerLifecycleService.stopWorker
//  Op.deleteSession         WorkerLifecycleService.deleteWorker / deleteCopilot
//  Op.renameSession         WorkerLifecycleService.renameWorker / renameCopilot
//  Op.restoreSession        SessionManager.getArchived + WorkerLifecycleService.restoreWorker /
//                             restoreCopilotAndFinalize                          (archive.ts)
//  Op.getLogs               TmuxBackendCore.capturePane (+ getWorker/getCopilot) (worker.ts)
//  Op.sendMessage           WorkerLifecycleService / TmuxBackendCore             (worker.ts)
//  Op.listTerminalPanes     SessionTerminalService.list
//  Op.createTerminalPane    SessionTerminalService.create
//  Op.focusTerminalPane     SessionTerminalService.focus
//  Op.closeTerminalPane     SessionTerminalService.close
//  Op.broadcastToWorkers    WorkerLifecycleService.broadcastToWorkers            (worker send --all)
//  Op.listNotifications     NotificationStore.list
//  Op.listNotificationOccurrencesV2 NotificationStore.listOccurrences
//  Op.markNotificationRead  NotificationStore.markRead
//  Op.dismissNotification   NotificationStore.dismiss
//  Op.clearNotifications    NotificationStore.clear
//  Op.getDiff               DiffService.getDiff (workdir from SessionManager)
//  Op.getFileSnapshot       DiffService.getFileSnapshot (path-constrained)
//  Op.getGitStatus          SessionManager.sync + git status --porcelain        (sidebar U:N)
//  Topic.events             EventHub (one tailer + in-process fan-out)            (eventHub.ts)
//  Topic.notifications      shared NotificationStateService.onDidChange
//  Topic.notificationOccurrencesV2 filtered NotificationStore occurrence snapshots
//  openTerminal             reserved in-process terminal seam; loopback attach
//                             is handled by TerminalBridge after ownership auth

import * as os from 'node:os';
import * as path from 'node:path';

import { TmuxBackendCore } from '@hydra/core/tmux';
import {
  AGENT_LABELS,
  agentSupportsCopilotMode,
  extractAgentCommandExecutable,
  getAgentDefaultCommand,
} from '@hydra/core/agentConfig';
import { resolveCommandPath } from '@hydra/core/exec';
import { logger } from '@hydra/core/logger';
import {
  isDirectoryWorker,
  SessionManager,
  type CopilotInfo,
  type WorkerInfo,
} from '@hydra/core/sessionManager';
import type { CopilotMode, MultiplexerBackendCore } from '@hydra/core/types';
import { WorkerRuntimeStateStore } from '@hydra/core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '@hydra/core/workerRuntimeV2';
import { NotificationStore } from '@hydra/core/notifications';
import { NotificationStateService } from '@hydra/core/notificationStateService';
import { EventLog, type HydraEventSource } from '@hydra/core/events';
import { EventHub } from '@hydra/core/eventHub';
import { AsyncPushIterator } from '@hydra/core/asyncPushIterator';
import { resolveAgentSessionFile, expandAndResolvePath } from '@hydra/core/path';
import {
  fetchOriginRequired,
  getBaseBranchFromRepo,
  getPrimaryRepoRootFromPath,
  localBranchExists,
} from '@hydra/core/git';
import { listRegisteredRepos, resolveRepoInput } from '@hydra/core/repoRegistry';
import {
  getHydraGlobalDefaultAgent,
  readHydraGlobalConfig,
} from '@hydra/core/hydraGlobalConfig';
import { DiffService } from '@hydra/core/diff';
import { getCopilotOnboardingPrompt } from '@hydra/core/copilotOnboarding';
import { WorkerLifecycleService } from '@hydra/core/workerLifecycleService';
import { createTransport } from '@hydra/core/transport/nexus';
import { NotificationMailboxMirror } from '@hydra/core/notificationMailboxMirror';
import { CopilotInboundBridge } from '@hydra/core/copilotInboundBridge';
import { RunTrackingRegistry } from '@hydra/core/runTrackingRegistry';
import { resolveHostPid } from '@hydra/core/hostPid';
import { SessionTerminalService } from '@hydra/core/sessionTerminalService';
import { AgentRuntimeRegistry, type AgentRuntime } from '@hydra/core/agentRuntime';

import { collectCodeWorkerGitStatus } from './gitStatus';

import {
  Op,
  Topic,
  type AgentRuntimeActionResult,
  type AgentRuntimeConnectInput,
  type AgentRuntimeEvent,
  type AgentRuntimeEventInput,
  type AgentRuntimeEventListResult,
  type AgentRuntimePromptInput,
  type AgentRuntimePromptResult,
  type AgentRuntimeSnapshot,
  type HydraAppService as HydraAppServiceApi,
  type BroadcastPayload,
  type BroadcastResult,
  type CreateCopilotInput,
  type CreateCopilotResult,
  type CreationAgentOption,
  type CreationOptionsResult,
  type CreationRepositoryOption,
  type CreateWorkerInput,
  type CreateWorkerResult,
  type DeleteSessionPayload,
  type DismissNotificationPayload,
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
  type NotificationKind,
  type NotificationListFilters,
  type NotificationListResult,
  type NotificationOccurrenceFiltersV2,
  type NotificationOccurrenceListV2Result,
  type NotificationOccurrenceSnapshotV2,
  type NotificationReadResult,
  type NotificationSnapshot,
  type NotificationStatus,
  type NotificationStatusMutationResult,
  type RenameSessionPayload,
  type RestoreSessionPayload,
  type SendMessagePayload,
  type SendResult,
  type SessionListCopilot,
  type SessionListWorker,
  type SessionResult,
  type StartSessionPayload,
  type StopWorkerPayload,
  type TerminalPaneCloseResult,
  type TerminalPaneCreateInput,
  type TerminalPaneListInput,
  type TerminalPaneListResult,
  type TerminalPaneTargetInput,
  type TerminalAttachInput,
  type TerminalChannel,
  type WorkerRuntimeCliSnapshot,
  type WorkerRuntimeListV2Result,
} from '@hydra/protocol';

const DEFAULT_LOG_LINES = 50;
const DEFAULT_AGENT_RUNTIME_SHUTDOWN_MS = 5000;
const MAX_AGENT_RUNTIME_STREAMS = 64;
const MAX_AGENT_RUNTIME_EVENTS = 128;
const MAX_AGENT_RUNTIME_BYTES = 1024 * 1024;
const MAX_NOTIFICATION_SESSION_LENGTH = 200;
const MAX_NOTIFICATION_OCCURRENCE_LIMIT = 1000;
const NOTIFICATION_KINDS = new Set<NotificationKind>([
  'complete',
  'needs-input',
  'error',
  'blocked',
  'info',
]);
const NOTIFICATION_STATUSES = new Set<NotificationStatus>([
  'active',
  'resolved',
  'superseded',
  'dismissed',
]);

interface NotificationOccurrenceSubscriber {
  readonly filters: NotificationOccurrenceFiltersV2;
  readonly stream: AsyncPushIterator<NotificationOccurrenceSnapshotV2>;
}

/** The injected registry is owned and stopped by this service, just like the default registry. */
export type AppAgentRuntimeRegistry = Pick<AgentRuntimeRegistry, 'connect' | 'get' | 'list' | 'stop' | 'stopAll'>;

interface AgentRuntimeSubscriber {
  readonly runtimeId: string;
  readonly runtime: AgentRuntime;
  readonly stream: AgentRuntimeEventStream;
}

export interface HydraAppServiceOptions {
  /** Multiplexer backend. Defaults to the real tmux backend. Tests inject a fake. */
  backend?: MultiplexerBackendCore;
  sessionManager?: SessionManager;
  notificationStore?: NotificationStore;
  runtimeStateStore?: WorkerRuntimeStateStore;
  runtimeV2Store?: WorkerRuntimeStateStoreV2;
  eventLog?: EventLog;
  eventHub?: EventHub;
  notificationStateService?: NotificationStateService;
  diffService?: DiffService;
  agentRuntimeRegistry?: AppAgentRuntimeRegistry;
  /** Upper bound for service shutdown, including an injected connector that fails to close. */
  agentRuntimeShutdownTimeoutMs?: number;
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
  private readonly runtimeV2Store: WorkerRuntimeStateStoreV2;
  private readonly workerLifecycle: WorkerLifecycleService;
  /** worker→copilot attention over nexus (gap #1); undefined on the legacy plane. */
  private readonly notificationMailboxMirror?: NotificationMailboxMirror;
  private readonly copilotInboundBridge?: CopilotInboundBridge;
  /** Tracking-plane symmetry: register copilot runs like WLS does workers (doc §5). */
  private readonly copilotTracking: RunTrackingRegistry<string>;
  private readonly sessionTerminal: SessionTerminalService;
  private readonly eventLog: EventLog;
  private readonly eventHub: EventHub;
  private readonly notificationStateService: NotificationStateService;
  private readonly diffService: DiffService;
  private readonly notificationEventSource: HydraEventSource;
  private readonly notificationStreams = new Set<AsyncPushIterator<NotificationSnapshot>>();
  private readonly notificationOccurrenceStreams = new Set<NotificationOccurrenceSubscriber>();
  private notificationStateSubscription: { dispose(): void } | undefined;
  private notificationStateInitialized = false;
  private readonly agentRuntimeRegistry: AppAgentRuntimeRegistry;
  private readonly agentRuntimeShutdownTimeoutMs: number;
  private readonly agentRuntimeStreams = new Set<AgentRuntimeSubscriber>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: HydraAppServiceOptions = {}) {
    this.agentRuntimeRegistry = options.agentRuntimeRegistry ?? new AgentRuntimeRegistry();
    this.agentRuntimeShutdownTimeoutMs = validateRuntimeTimeout(
      options.agentRuntimeShutdownTimeoutMs, 'agentRuntimeShutdownTimeoutMs', 120000,
    ) ?? DEFAULT_AGENT_RUNTIME_SHUTDOWN_MS;
    this.backend = options.backend ?? new TmuxBackendCore();
    this.eventLog = options.eventLog ?? new EventLog();
    this.runtimeStateStore = options.runtimeStateStore ?? new WorkerRuntimeStateStore(undefined, this.eventLog);
    this.runtimeV2Store = options.runtimeV2Store ?? new WorkerRuntimeStateStoreV2();
    this.sessionManager = options.sessionManager ?? new SessionManager(this.backend, this.eventLog, this.runtimeStateStore);
    this.notificationStore = options.notificationStore ?? new NotificationStore(
      undefined,
      undefined,
      this.eventLog,
      undefined,
      Date.now,
      undefined,
      this.runtimeV2Store,
    );
    this.eventHub = options.eventHub ?? new EventHub(this.eventLog);
    this.notificationStateService = options.notificationStateService ?? new NotificationStateService({
      store: this.notificationStore,
      eventLog: this.eventLog,
      eventHub: this.eventHub,
    });
    this.diffService = options.diffService ?? new DiffService();
    this.notificationEventSource = options.notificationEventSource ?? 'session-manager';
    // Two synchronized switchable planes (a2a-mapping doc §5), by HYDRA_TRANSPORT.
    // Defaults to legacy (tmux + no-op tracking) so this is inert unless nexus/dual is
    // selected; nexus/dual gRPC channels die with the sidecar's process.exit on shutdown.
    // `backend` powers the legacy (tmux) message plane.
    const transport = createTransport({ backend: this.backend });
    this.workerLifecycle = new WorkerLifecycleService({
      backend: this.backend,
      sessionManager: this.sessionManager,
      notificationStore: this.notificationStore,
      runtimeStateStore: this.runtimeStateStore,
      runtimeV2Store: this.runtimeV2Store,
      eventLog: this.eventLog,
      eventSource: this.notificationEventSource,
      runTracker: transport.runTracker,
      messageTransport: transport.messageTransport,
      mode: transport.mode,
    });
    // Tracking-plane symmetry: copilots register like workers do (WLS). The
    // RunTracker is the switch (Noop legacy / Nexus / Dual), so no gating.
    this.copilotTracking = new RunTrackingRegistry<string>(
      transport.runTracker,
      'nexus-tracking.copilot',
    );
    // worker→copilot attention over nexus (a2a-mapping doc §5): mirror local
    // copilot-directed attention to the copilot's mailbox, and re-materialize a
    // peer's mailbox back into this machine's NotificationStore. Uses the PURE
    // nexus transport (never the dual composite — that would tmux-inject a
    // serialized notification). Absent on the legacy plane.
    if (transport.nexusMessageTransport) {
      this.notificationMailboxMirror = new NotificationMailboxMirror({
        store: this.notificationStore,
        messageTransport: transport.nexusMessageTransport,
      });
      this.notificationMailboxMirror.start();
      this.copilotInboundBridge = new CopilotInboundBridge({
        store: this.notificationStore,
        messageTransport: transport.nexusMessageTransport,
      });
    }
    this.sessionTerminal = new SessionTerminalService(this.backend, this.sessionManager);
  }

  // ── transport waist (3 methods) + sidecar-internal terminal authorization ──

  // `auth` is part of the HydraAppService contract but ignored in-process; it is
  // omitted here (optional params may be dropped by an implementer) and wired in
  // when the loopback server / hydrad enforce it. See FINAL.md §"Security".
  async request<TReq, TRes>(op: string, payload: TReq): Promise<TRes> {
    this.assertNotDisposed();
    return (await this.dispatch(op, payload)) as TRes;
  }

  stream<TReq, TEvt>(topic: string, payload: TReq): AsyncIterable<TEvt> {
    this.assertNotDisposed();
    switch (topic) {
      case Topic.agentRuntimeEvents:
        return this.subscribeAgentRuntimeEvents(payload) as AsyncIterable<TEvt>;
      case Topic.events:
        return this.subscribeEvents((payload ?? {}) as EventSubscribeInput) as AsyncIterable<TEvt>;
      case Topic.notifications:
        return this.subscribeNotifications() as AsyncIterable<TEvt>;
      case Topic.notificationOccurrencesV2:
        return this.subscribeNotificationOccurrencesV2(
          (payload ?? {}) as NotificationOccurrenceFiltersV2,
        ) as AsyncIterable<TEvt>;
      default:
        throw new Error(`HydraAppService: unknown stream topic "${topic}"`);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.notificationMailboxMirror?.dispose();
    this.copilotInboundBridge?.dispose();
    this.eventHub.dispose();
    for (const stream of [...this.notificationStreams]) stream.close();
    for (const subscriber of [...this.notificationOccurrenceStreams]) subscriber.stream.close();
    this.stopNotificationState();
    for (const subscriber of [...this.agentRuntimeStreams]) subscriber.stream.close();
    this.disposePromise = boundedRuntimeShutdown(
      Promise.resolve().then(() => this.agentRuntimeRegistry.stopAll()),
      this.agentRuntimeShutdownTimeoutMs,
    );
    // Existing in-process hosts may dispose synchronously. Keep rejection observable
    // to awaiting hosts without causing an unhandled rejection in those callers.
    void this.disposePromise.catch(() => {});
    return this.disposePromise;
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
      case Op.connectAgentRuntime:
        return this.connectAgentRuntime(payload);
      case Op.listAgentRuntimes: {
        const runtimes = this.agentRuntimeRegistry.list();
        return { runtimes, count: runtimes.length };
      }
      case Op.getAgentRuntime:
        return this.requireAgentRuntime(validateRuntimeTarget(payload)).snapshot();
      case Op.getAgentRuntimeEvents:
        return this.getAgentRuntimeEvents(payload);
      case Op.promptAgentRuntime:
        return this.promptAgentRuntime(payload);
      case Op.cancelAgentRuntime:
        return this.cancelAgentRuntime(payload);
      case Op.stopAgentRuntime:
        return this.stopAgentRuntime(payload);
      case Op.answerAgentRuntimePermission:
        return this.answerAgentRuntimePermission(payload);
      case Op.answerAgentRuntimeQuestion:
        return this.answerAgentRuntimeQuestion(payload);
      case Op.listSessions:
        return this.listSessions();
      case Op.getCreationOptions:
        return this.getCreationOptions();
      case Op.listWorkerRuntimeV2:
        return this.listWorkerRuntimeV2();
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
      case Op.listTerminalPanes:
        return this.listTerminalPanes(payload as TerminalPaneListInput);
      case Op.createTerminalPane:
        return this.createTerminalPane(payload as TerminalPaneCreateInput);
      case Op.focusTerminalPane:
        return this.focusTerminalPane(payload as TerminalPaneTargetInput);
      case Op.closeTerminalPane:
        return this.closeTerminalPane(payload as TerminalPaneTargetInput);
      case Op.broadcastToWorkers:
        return this.broadcastToWorkers(payload as BroadcastPayload);
      case Op.listNotifications:
        return this.listNotifications(payload as NotificationListFilters);
      case Op.listNotificationOccurrencesV2:
        return this.listNotificationOccurrencesV2(
          (payload ?? {}) as NotificationOccurrenceFiltersV2,
        );
      case Op.markNotificationRead:
        return this.markNotificationRead(payload as MarkNotificationReadPayload);
      case Op.dismissNotification:
        return this.dismissNotification(payload as DismissNotificationPayload);
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

  private async connectAgentRuntime(value: unknown): Promise<AgentRuntimeSnapshot> {
    const input = validateRuntimeConnect(value);
    const closeBudget = Math.max(1, Math.floor(this.agentRuntimeShutdownTimeoutMs * 0.75));
    if (input.closeTimeoutMs !== undefined && input.closeTimeoutMs > closeBudget) {
      throw new Error('closeTimeoutMs exceeds this host\'s shutdown budget');
    }
    const connecting = this.agentRuntimeRegistry.connect(input.id, {
      workspace: input.workspace, scodeArgv: input.scodeArgv, env: input.env,
      acpSessionId: input.acpSessionId,
      startupTimeoutMs: input.startupTimeoutMs, closeTimeoutMs: input.closeTimeoutMs ?? Math.min(3000, closeBudget),
    }, { permissionMode: input.permissionMode, inputMode: input.inputMode });
    const ownedRuntime = this.agentRuntimeRegistry.get(input.id);
    try {
      const runtime = await connecting;
      this.assertNotDisposed();
      return runtime.snapshot();
    } catch (error) {
      if (ownedRuntime && this.agentRuntimeRegistry.get(input.id) !== ownedRuntime) {
        this.closeAgentRuntimeStreams(ownedRuntime);
      }
      throw error;
    }
  }

  private requireAgentRuntime(id: string): AgentRuntime {
    const runtime = this.agentRuntimeRegistry.get(id);
    if (!runtime) throw new Error(`Unknown agent runtime "${id}"`);
    return runtime;
  }

  private getAgentRuntimeEvents(value: unknown): AgentRuntimeEventListResult {
    const input = validateRuntimeEvents(value);
    const runtime = this.requireAgentRuntime(input.id);
    const events = runtime.events(input.afterSequence);
    return { runtimeId: input.id, events, count: events.length, lastSequence: runtime.snapshot().lastSequence };
  }

  private async promptAgentRuntime(value: unknown): Promise<AgentRuntimePromptResult> {
    const input = validateRuntimePrompt(value);
    const result = await this.requireAgentRuntime(input.id).prompt(input.content);
    return { runtimeId: input.id, result };
  }

  private async cancelAgentRuntime(value: unknown): Promise<AgentRuntimeActionResult> {
    const id = validateRuntimeTarget(value);
    await this.requireAgentRuntime(id).cancel();
    return { runtimeId: id, status: 'cancel-requested' };
  }

  private async stopAgentRuntime(value: unknown): Promise<AgentRuntimeActionResult> {
    const id = validateRuntimeTarget(value);
    const runtime = this.requireAgentRuntime(id);
    if (!await this.agentRuntimeRegistry.stop(id)) throw new Error(`Unknown agent runtime "${id}"`);
    this.closeAgentRuntimeStreams(runtime);
    return { runtimeId: id, status: 'stopped' };
  }

  private closeAgentRuntimeStreams(runtime: AgentRuntime): void {
    for (const subscriber of [...this.agentRuntimeStreams]) {
      if (subscriber.runtime === runtime) subscriber.stream.close();
    }
  }

  private answerAgentRuntimePermission(value: unknown): AgentRuntimeActionResult {
    const id = validateRuntimeTarget(value);
    if (!isRecord(value)) throw new Error('agent runtime permission answer must be an object');
    const requestId = runtimeString(value.requestId, 'requestId', 200);
    const optionId = value.optionId === null ? null : runtimeString(value.optionId, 'optionId', 1000);
    if (!this.requireAgentRuntime(id).respondToPermission(requestId, optionId)) {
      throw new Error('Pending manual agent permission request not found');
    }
    return { runtimeId: id, status: 'answered' };
  }

  private answerAgentRuntimeQuestion(value: unknown): AgentRuntimeActionResult {
    const id = validateRuntimeTarget(value);
    if (!isRecord(value)) throw new Error('agent runtime question answer must be an object');
    const requestId = runtimeString(value.requestId, 'requestId', 200);
    if (value.answers !== null && (!Array.isArray(value.answers) || value.answers.length > 100)) {
      throw new Error('answers must be null or an array of at most 100 answers');
    }
    const answers = value.answers === null ? null : (value.answers as unknown[]).map(answer => {
      if (!isRecord(answer) || typeof answer.value !== 'string' || answer.value.length > 65536
        || (answer.label !== undefined && answer.label !== null && typeof answer.label !== 'string')) {
        throw new Error('Each question answer requires an id and string value');
      }
      return {
        id: runtimeString(answer.id, 'answer.id', 1000), value: answer.value,
        ...(answer.label !== undefined ? { label: answer.label as string | null } : {}),
      };
    });
    if (!this.requireAgentRuntime(id).respondToQuestion(requestId, answers)) {
      throw new Error('Pending manual agent question request not found');
    }
    return { runtimeId: id, status: 'answered' };
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('HydraAppService is disposed');
  }

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

  /** Local defaults and recent sources used to make Desktop create forms concrete. */
  private async getCreationOptions(): Promise<CreationOptionsResult> {
    const [state, agents] = await Promise.all([
      this.sessionManager.sync(),
      this.collectCreationAgents(),
    ]);
    const defaultAgent = getHydraGlobalDefaultAgent().agent;
    const existingCopilotNames = new Set(
      Object.values(state.copilots).flatMap(copilot => [
        copilot.displayName,
        copilot.sessionName,
        copilot.tmuxSession,
      ].filter((value): value is string => Boolean(value))),
    );

    const agentOptions = agents.map(agent => ({
      ...agent,
      isDefault: agent.id === defaultAgent,
      suggestedCopilotName: uniqueSessionName(`hydra-copilot-${agent.id}`, existingCopilotNames),
      suggestedPlanName: uniqueSessionName(`hydra-plan-${agent.id}`, existingCopilotNames),
    }));

    return {
      defaultAgent,
      homeDir: os.homedir(),
      agents: agentOptions,
      repositories: await this.collectCreationRepositories(Object.values(state.workers)),
    };
  }

  private async collectCreationAgents(): Promise<Array<Omit<
    CreationAgentOption,
    'isDefault' | 'suggestedCopilotName' | 'suggestedPlanName'
  >>> {
    const config = readHydraGlobalConfig();
    const configuredCommands = config.agentCommands ?? {};
    const defaultAgent = getHydraGlobalDefaultAgent().agent;
    const agentIds = [
      ...Object.keys(AGENT_LABELS),
      ...Object.keys(configuredCommands).filter(id => !(id in AGENT_LABELS)),
      ...(defaultAgent in AGENT_LABELS || defaultAgent in configuredCommands ? [] : [defaultAgent]),
    ];

    return Promise.all(agentIds.map(async (id) => {
      const command = configuredCommands[id] || getAgentDefaultCommand(id) || '';
      const executable = extractAgentCommandExecutable(command);
      return {
        id,
        label: AGENT_LABELS[id as keyof typeof AGENT_LABELS] || humanizeAgentId(id),
        available: Boolean(executable && await resolveCommandPath(executable)),
        supportsPlanMode: agentSupportsCopilotMode(id, 'plan'),
      };
    }));
  }

  private async collectCreationRepositories(
    workers: WorkerInfo[],
  ): Promise<CreationRepositoryOption[]> {
    const repositories = new Map<string, Omit<CreationRepositoryOption, 'defaultBranch'>>();
    const codeWorkers = workers
      .filter(worker => !isDirectoryWorker(worker) && Boolean(worker.workdir))
      .sort((left, right) => right.workerId - left.workerId);

    for (const worker of codeWorkers) {
      try {
        const repoPath = path.resolve(await getPrimaryRepoRootFromPath(worker.workdir));
        mergeCreationRepository(repositories, {
          value: repoPath,
          label: worker.repo || path.basename(repoPath),
          path: repoPath,
          aliases: [worker.workdir],
          sources: ['recent'],
        });
      } catch {
        // A removed or inaccessible historical worktree should not block the dialog.
      }
    }

    for (const repo of listRegisteredRepos()) {
      const repoPath = path.resolve(repo.path);
      mergeCreationRepository(repositories, {
        value: repoPath,
        label: repo.canonical,
        path: repoPath,
        aliases: [],
        sources: ['registered'],
      });
    }

    return Promise.all([...repositories.values()].map(async (repo) => ({
      ...repo,
      defaultBranch: await getBaseBranchFromRepo(repo.path).catch(() => null),
    })));
  }

  /** Capture the event cursor before the store read so a concurrent change cannot be skipped. */
  private async listWorkerRuntimeV2(): Promise<WorkerRuntimeListV2Result> {
    const lastEventSeq = this.eventLog.readLastSeq();
    const runtimes = this.runtimeV2Store.list();
    return {
      version: 2,
      loadedAt: new Date().toISOString(),
      lastEventSeq,
      runtimes,
      count: runtimes.length,
    };
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
      const repoRoot = await getPrimaryRepoRootFromPath(repoPath);
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

  /**
   * Persist the Copilot immediately, then finish agent readiness/onboarding in
   * the background. Desktop can close its modal and open the terminal as soon
   * as the durable session exists instead of blocking behind a 30s TUI probe.
   */
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

    const creation = await this.sessionManager.createCopilot({
      workdir, agentType, copilotMode, name: input.name, sessionName,
    });
    const copilot = creation.copilotInfo;
    // nexus/dual: tail this copilot's mailbox so a worker's attention raised on
    // another machine re-materializes into this machine's NotificationStore.
    this.copilotInboundBridge?.start(copilot.sessionName);
    // Report the copilot run into the tracking plane (best-effort; no-op on legacy).
    void this.registerCopilotRun(copilot.sessionName);
    void this.finishCopilotInitialization(
      copilot,
      creation.postCreatePromise,
      input.task?.trim() || undefined,
    );

    return {
      status: 'created',
      session: copilot.sessionName,
      agent: copilot.agent,
      mode: copilot.copilotMode,
      workdir: copilot.workdir,
      agentSessionId: copilot.sessionId,
    };
  }

  /** Report a copilot run into the tracking plane (best-effort; mirrors WLS). */
  private async registerCopilotRun(sessionName: string): Promise<void> {
    if (this.copilotTracking.has(sessionName)) {
      return;
    }
    const hostPid = await resolveHostPid(this.backend, sessionName);
    if (hostPid === null) {
      return;
    }
    await this.copilotTracking.register(sessionName, {
      name: sessionName,
      hostPid,
      connectionId: `${sessionName}#copilot`,
      labels: { role: 'copilot' },
    });
  }

  private async finishCopilotInitialization(
    copilot: CopilotInfo,
    postCreatePromise: Promise<void>,
    initialTask?: string,
  ): Promise<void> {
    try {
      await postCreatePromise;
      if (!await this.sessionManager.isAgentReady(copilot.sessionName, copilot.agent)) {
        logger.warn('sidecar.createCopilot', 'Skipping Copilot prompts because the agent is not ready', {
          sessionName: copilot.sessionName,
          agent: copilot.agent,
        });
        return;
      }
      await this.sendCopilotOnboarding(copilot.sessionName, copilot.copilotMode);
      if (initialTask) {
        await this.backend.sendMessage(copilot.sessionName, initialTask);
      }
    } catch (error) {
      logger.warn('sidecar.createCopilot', 'Copilot created but background initialization failed', {
        sessionName: copilot.sessionName,
        agent: copilot.agent,
        error,
      });
    }
  }

  private async sendCopilotOnboarding(sessionName: string, copilotMode: CopilotMode): Promise<void> {
    await this.backend.sendMessage(sessionName, getCopilotOnboardingPrompt(copilotMode));
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
    this.copilotInboundBridge?.stop(payload.session);
    await this.copilotTracking.unregister(payload.session);
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

  private async listTerminalPanes(payload: TerminalPaneListInput): Promise<TerminalPaneListResult> {
    return this.sessionTerminal.list(payload?.session);
  }

  private async createTerminalPane(input: TerminalPaneCreateInput): Promise<TerminalPaneListResult> {
    return this.sessionTerminal.create(input);
  }

  private async focusTerminalPane(input: TerminalPaneTargetInput): Promise<TerminalPaneListResult> {
    return this.sessionTerminal.focus(input?.session, input?.paneId);
  }

  private async closeTerminalPane(input: TerminalPaneTargetInput): Promise<TerminalPaneCloseResult> {
    return this.sessionTerminal.close(input?.session, input?.paneId);
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

  /** NotificationStore occurrence history, filtered at the trusted sidecar boundary. */
  private async listNotificationOccurrencesV2(
    filters: NotificationOccurrenceFiltersV2,
  ): Promise<NotificationOccurrenceListV2Result> {
    return this.buildNotificationOccurrenceList(validateNotificationOccurrenceFilters(filters));
  }

  /** NotificationStore.markRead. */
  private async markNotificationRead(payload: MarkNotificationReadPayload): Promise<NotificationReadResult> {
    return this.notificationStore.markRead(payload.id, this.notificationEventSource);
  }

  /** NotificationStore.dismiss. Runtime remains unchanged. */
  private async dismissNotification(payload: DismissNotificationPayload): Promise<NotificationStatusMutationResult> {
    return this.notificationStore.dismiss(payload.id, this.notificationEventSource);
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

  private subscribeAgentRuntimeEvents(value: unknown): AsyncIterableIterator<AgentRuntimeEvent> {
    const input = validateRuntimeEvents(value);
    const runtime = this.requireAgentRuntime(input.id);
    if (this.agentRuntimeStreams.size >= MAX_AGENT_RUNTIME_STREAMS) {
      throw new Error('Too many agent runtime event subscribers');
    }
    let unsubscribe = () => {};
    let subscriber: AgentRuntimeSubscriber;
    const stream = new AgentRuntimeEventStream(() => {
      unsubscribe();
      this.agentRuntimeStreams.delete(subscriber);
    });
    subscriber = { runtimeId: input.id, runtime, stream };
    this.agentRuntimeStreams.add(subscriber);
    unsubscribe = runtime.subscribe(event => {
      if (event.sequence > (input.afterSequence ?? 0)) stream.push(event);
    }, { replay: true });
    if (stream.isClosed) unsubscribe();
    return stream;
  }

  /**
   * EventHub drains retained history once, emits local appends synchronously,
   * and uses one seq-cursored tailer for CLI, extension, and hook writers.
   */
  private subscribeEvents(input: EventSubscribeInput): AsyncIterableIterator<HydraEvent> {
    return this.eventHub.subscribe(input.after ?? 0);
  }

  /**
   * One shared NotificationStateService yields a snapshot per subscriber and
   * fans out each change. The watcher is disposed after the last subscriber.
   */
  private subscribeNotifications(): AsyncIterableIterator<NotificationSnapshot> {
    this.startNotificationState();
    let stream: AsyncPushIterator<NotificationSnapshot>;
    stream = new AsyncPushIterator(() => {
      this.notificationStreams.delete(stream);
      this.stopNotificationStateIfIdle();
    });
    this.notificationStreams.add(stream);
    stream.push(this.notificationStateService.getSnapshot());
    return stream;
  }

  private subscribeNotificationOccurrencesV2(
    input: NotificationOccurrenceFiltersV2,
  ): AsyncIterableIterator<NotificationOccurrenceSnapshotV2> {
    const filters = validateNotificationOccurrenceFilters(input);
    this.startNotificationState();
    let subscriber: NotificationOccurrenceSubscriber;
    const stream = new AsyncPushIterator<NotificationOccurrenceSnapshotV2>(() => {
      this.notificationOccurrenceStreams.delete(subscriber);
      this.stopNotificationStateIfIdle();
    });
    subscriber = { filters, stream };
    this.notificationOccurrenceStreams.add(subscriber);
    stream.push(this.buildNotificationOccurrenceSnapshot(filters));
    return stream;
  }

  private startNotificationState(): void {
    if (this.notificationStateInitialized) return;
    this.notificationStateInitialized = true;
    this.notificationStateService.initialize();
    this.notificationStateSubscription = this.notificationStateService.onDidChange(snapshot => {
      for (const stream of this.notificationStreams) stream.push(snapshot);
      for (const subscriber of this.notificationOccurrenceStreams) {
        subscriber.stream.push(this.buildNotificationOccurrenceSnapshot(subscriber.filters));
      }
    });
  }

  private stopNotificationStateIfIdle(): void {
    if (this.notificationStreams.size === 0 && this.notificationOccurrenceStreams.size === 0) {
      this.stopNotificationState();
    }
  }

  private stopNotificationState(): void {
    if (!this.notificationStateInitialized) return;
    this.notificationStateInitialized = false;
    this.notificationStateSubscription?.dispose();
    this.notificationStateSubscription = undefined;
    this.notificationStateService.dispose();
  }

  private buildNotificationOccurrenceSnapshot(
    filters: NotificationOccurrenceFiltersV2,
  ): NotificationOccurrenceSnapshotV2 {
    const lastEventSeq = this.eventLog.readLastSeq();
    return {
      ...this.buildNotificationOccurrenceList(filters),
      loadedAt: new Date().toISOString(),
      lastEventSeq,
    };
  }

  private buildNotificationOccurrenceList(
    filters: NotificationOccurrenceFiltersV2,
  ): NotificationOccurrenceListV2Result {
    const matching = this.notificationStore.listOccurrences()
      .filter(occurrence => matchesNotificationOccurrenceFilters(occurrence, filters));
    const occurrences = filters.limit === undefined
      ? matching
      : matching.slice(0, filters.limit);
    return {
      version: 2,
      occurrences,
      count: occurrences.length,
      totalCount: matching.length,
      activeCount: matching.filter(occurrence => occurrence.status === 'active').length,
      unreadCount: matching.filter(occurrence => occurrence.readAt === null).length,
    };
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

/** Slow consumers are detached rather than retaining unbounded ACP content. */
class AgentRuntimeEventStream implements AsyncIterableIterator<AgentRuntimeEvent> {
  private readonly queued: Array<{ event: AgentRuntimeEvent; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<AgentRuntimeEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private bytes = 0;
  private closed = false;
  private failure: Error | undefined;

  constructor(private readonly onClose: () => void) {}
  get isClosed(): boolean { return this.closed; }
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentRuntimeEvent> { return this; }

  next(): Promise<IteratorResult<AgentRuntimeEvent>> {
    const queued = this.queued.shift();
    if (queued) {
      this.bytes -= queued.bytes;
      return Promise.resolve({ value: queued.event, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<AgentRuntimeEvent>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(error?: unknown): Promise<IteratorResult<AgentRuntimeEvent>> {
    this.close();
    return Promise.reject(error);
  }

  push(event: AgentRuntimeEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) { waiter.resolve({ value: event, done: false }); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.queued.length >= MAX_AGENT_RUNTIME_EVENTS || this.bytes + bytes > MAX_AGENT_RUNTIME_BYTES) {
      this.close(new Error('Agent runtime event subscriber exceeded the bounded buffer; reconnect using afterSequence'));
      return;
    }
    this.bytes += bytes;
    this.queued.push({ event, bytes });
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.queued.length = 0;
    this.bytes = 0;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve({ value: undefined, done: true });
    }
    this.onClose();
  }
}

function runtimeString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters without NUL`);
  }
  return value;
}

function validateRuntimeTarget(value: unknown): string {
  if (!isRecord(value)) throw new Error('agent runtime input must be an object');
  const id = runtimeString(value.id, 'id', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)) throw new Error('agent runtime id contains unsupported characters');
  return id;
}

function validateRuntimeTimeout(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function validateRuntimeConnect(value: unknown): AgentRuntimeConnectInput {
  const id = validateRuntimeTarget(value);
  if (!isRecord(value)) throw new Error('agent runtime input must be an object');
  if (value.kind !== 'scode-acp') throw new Error(`Unsupported agent runtime kind "${String(value.kind)}"`);
  const workspace = runtimeString(value.workspace, 'workspace', 32768);
  if (!path.isAbsolute(workspace)) throw new Error('agent runtime workspace must be absolute');
  if (!Array.isArray(value.scodeArgv) || !value.scodeArgv.length || value.scodeArgv.length > 256
    || value.scodeArgv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32768)) {
    throw new Error('scodeArgv must be an array of 1 to 256 literal argv strings without NUL');
  }
  runtimeString(value.scodeArgv[0], 'scodeArgv executable', 32768);
  const input: AgentRuntimeConnectInput = {
    id, kind: 'scode-acp', workspace, scodeArgv: [...value.scodeArgv] as string[],
  };
  if (value.acpSessionId !== undefined) input.acpSessionId = runtimeString(value.acpSessionId, 'acpSessionId', 1000);
  for (const key of ['permissionMode', 'inputMode'] as const) {
    const mode = value[key];
    if (mode !== undefined && mode !== 'cancel' && mode !== 'manual') throw new Error(`${key} must be cancel or manual`);
    if (mode !== undefined) input[key] = mode;
  }
  input.startupTimeoutMs = validateRuntimeTimeout(value.startupTimeoutMs, 'startupTimeoutMs', 120000);
  input.closeTimeoutMs = validateRuntimeTimeout(value.closeTimeoutMs, 'closeTimeoutMs', 30000);
  if (value.env !== undefined) {
    if (!isRecord(value.env) || Object.keys(value.env).length > 256) throw new Error('env must be an object with at most 256 entries');
    input.env = {};
    for (const [key, entry] of Object.entries(value.env)) {
      if (!key || key.includes('=') || key.includes('\0')
        || (entry !== null && (typeof entry !== 'string' || entry.includes('\0')))) {
        throw new Error('env requires valid variable names and string or null values');
      }
      Object.defineProperty(input.env, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
  }
  return input;
}

function validateRuntimeEvents(value: unknown): AgentRuntimeEventInput {
  const id = validateRuntimeTarget(value);
  const afterSequence = (value as Record<string, unknown>).afterSequence;
  if (afterSequence !== undefined
    && (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
    throw new Error('afterSequence must be a non-negative safe integer');
  }
  return { id, afterSequence: afterSequence as number | undefined };
}

function validateRuntimePrompt(value: unknown): AgentRuntimePromptInput {
  const id = validateRuntimeTarget(value);
  const content = (value as Record<string, unknown>).content;
  if (typeof content === 'string') {
    if (!content.length || Buffer.byteLength(content) > 4 * MAX_AGENT_RUNTIME_BYTES) throw new Error('prompt content must contain 1 to 4194304 bytes');
    return { id, content };
  }
  if (!Array.isArray(content) || !content.length || content.length > 256) {
    throw new Error('prompt content must be a string or an array of 1 to 256 ACP content blocks');
  }
  let serialized: string;
  try { serialized = JSON.stringify(content); } catch { throw new Error('ACP content blocks must be JSON serializable'); }
  if (Buffer.byteLength(serialized) > 4 * MAX_AGENT_RUNTIME_BYTES) throw new Error('ACP content blocks exceed 4194304 bytes');
  const blocks = JSON.parse(serialized) as unknown[];
  for (const block of blocks) validateRuntimeContentBlock(block);
  return { id, content: blocks as AgentRuntimePromptInput['content'] };
}

function validateRuntimeContentBlock(value: unknown): void {
  if (!isRecord(value)) throw new Error('ACP content block must be an object');
  if (value._meta !== undefined && value._meta !== null && !isRecord(value._meta)) throw new Error('ACP _meta must be an object');
  if (value.annotations !== undefined && value.annotations !== null) {
    const annotations = value.annotations;
    if (!isRecord(annotations)
      || (annotations._meta !== undefined && annotations._meta !== null && !isRecord(annotations._meta))
      || (annotations.lastModified !== undefined && annotations.lastModified !== null && typeof annotations.lastModified !== 'string')
      || (annotations.audience !== undefined && annotations.audience !== null
        && (!Array.isArray(annotations.audience) || annotations.audience.some(role => role !== 'assistant' && role !== 'user')))
      || (annotations.priority !== undefined && annotations.priority !== null
        && (typeof annotations.priority !== 'number' || !Number.isFinite(annotations.priority) || annotations.priority < 0 || annotations.priority > 1))) {
      throw new Error('Invalid ACP content annotations');
    }
  }
  const requireString = (record: Record<string, unknown>, key: string) => {
    if (typeof record[key] !== 'string') throw new Error(`ACP ${String(value.type)} content requires a string ${key}`);
  };
  for (const key of ['mimeType', 'uri', 'description', 'title'] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') throw new Error(`ACP ${key} must be a string`);
  }
  switch (value.type) {
    case 'text': requireString(value, 'text'); break;
    case 'image':
    case 'audio': requireString(value, 'data'); requireString(value, 'mimeType'); break;
    case 'resource_link':
      requireString(value, 'name'); requireString(value, 'uri');
      if (value.size !== undefined && value.size !== null
        && (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)) throw new Error('ACP resource size must be a non-negative safe integer');
      break;
    case 'resource': {
      if (!isRecord(value.resource)) throw new Error('ACP resource content requires a resource object');
      if (value.resource._meta !== undefined && value.resource._meta !== null && !isRecord(value.resource._meta)) throw new Error('ACP resource _meta must be an object');
      requireString(value.resource, 'uri');
      if (typeof value.resource.text !== 'string' && typeof value.resource.blob !== 'string') throw new Error('ACP embedded resource requires text or blob');
      if (value.resource.mimeType !== undefined && value.resource.mimeType !== null && typeof value.resource.mimeType !== 'string') throw new Error('ACP resource mimeType must be a string');
      break;
    }
    default: throw new Error(`Unsupported ACP content block type "${String(value.type)}"`);
  }
}

function boundedRuntimeShutdown(operation: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent runtime shutdown timed out after ${milliseconds}ms`)), milliseconds);
    operation.then(
      () => { clearTimeout(timer); resolve(); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function mergeCreationRepository(
  repositories: Map<string, Omit<CreationRepositoryOption, 'defaultBranch'>>,
  candidate: Omit<CreationRepositoryOption, 'defaultBranch'>,
): void {
  const key = path.resolve(candidate.path);
  const existing = repositories.get(key);
  if (!existing) {
    repositories.set(key, candidate);
    return;
  }
  repositories.set(key, {
    ...existing,
    aliases: [...new Set([...existing.aliases, ...candidate.aliases])],
    sources: [...new Set([...existing.sources, ...candidate.sources])],
  });
}

function uniqueSessionName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function humanizeAgentId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || id;
}

function validateNotificationOccurrenceFilters(
  value: unknown,
): NotificationOccurrenceFiltersV2 {
  if (!isRecord(value)) {
    throw new Error('notification occurrence filters must be an object');
  }

  const filters: NotificationOccurrenceFiltersV2 = {};
  const workerId = value.workerId;
  if (workerId !== undefined) {
    if (typeof workerId !== 'number' || !Number.isSafeInteger(workerId) || workerId <= 0) {
      throw new Error('workerId must be a positive safe integer');
    }
    filters.workerId = workerId;
  }
  for (const key of ['session', 'sourceSession', 'targetSession'] as const) {
    const session = value[key];
    if (session === undefined) continue;
    if (typeof session !== 'string' || session.length === 0 || session.length > MAX_NOTIFICATION_SESSION_LENGTH) {
      throw new Error(`${key} must be a non-empty string of at most ${MAX_NOTIFICATION_SESSION_LENGTH} characters`);
    }
    filters[key] = session;
  }
  const kind = value.kind;
  if (kind !== undefined) {
    if (typeof kind !== 'string' || !NOTIFICATION_KINDS.has(kind as NotificationKind)) {
      throw new Error(`unsupported notification kind "${String(kind)}"`);
    }
    filters.kind = kind as NotificationKind;
  }
  const status = value.status;
  if (status !== undefined) {
    if (typeof status !== 'string' || !NOTIFICATION_STATUSES.has(status as NotificationStatus)) {
      throw new Error(`unsupported notification status "${String(status)}"`);
    }
    filters.status = status as NotificationStatus;
  }
  const limit = value.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_NOTIFICATION_OCCURRENCE_LIMIT) {
      throw new Error(`limit must be a positive safe integer no greater than ${MAX_NOTIFICATION_OCCURRENCE_LIMIT}`);
    }
    filters.limit = limit;
  }
  return filters;
}

function matchesNotificationOccurrenceFilters(
  occurrence: NotificationOccurrenceSnapshotV2['occurrences'][number],
  filters: NotificationOccurrenceFiltersV2,
): boolean {
  if (filters.workerId !== undefined && occurrence.workerId !== filters.workerId) return false;
  if (filters.session !== undefined
    && occurrence.sourceSession !== filters.session
    && occurrence.targetSession !== filters.session) return false;
  if (filters.sourceSession !== undefined && occurrence.sourceSession !== filters.sourceSession) return false;
  if (filters.targetSession !== undefined && occurrence.targetSession !== filters.targetSession) return false;
  if (filters.kind !== undefined && occurrence.kind !== filters.kind) return false;
  if (filters.status !== undefined && occurrence.status !== filters.status) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
