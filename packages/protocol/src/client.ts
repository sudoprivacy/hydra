// The domain client — the ONLY thing a UI (renderer, web dashboard, or the
// smoke) imports. Verbs mirror docs/cli-contract.md and are written ONCE as
// `verb → transport.request(op, payload)` (or `.stream` / `.openTerminal`),
// with no per-transport duplication. Swapping InProcessTransport for a
// LoopbackHttpWsTransport (M1) or RestWsTransport (Fork B) changes nothing here.

import { Op, Topic } from './ops';
import type { HydraTransport } from './transport';
import type {
  AuthContext,
  SessionKind,
  TerminalAttachInput,
  TerminalChannel,
} from './types';
import type {
  BroadcastPayload,
  BroadcastResult,
  CreateCopilotInput,
  CreateCopilotResult,
  CreateWorkerInput,
  CreateWorkerResult,
  DeleteSessionOptions,
  DeleteSessionPayload,
  DismissNotificationPayload,
  DiffSummary,
  EventSubscribeInput,
  FileSnapshot,
  FileSnapshotInput,
  GetDiffPayload,
  GetLogsPayload,
  GitStatusMap,
  HydraEvent,
  HydraSessionList,
  LogResult,
  MarkNotificationReadPayload,
  NotificationClearFilters,
  NotificationClearResult,
  NotificationListFilters,
  NotificationListResult,
  NotificationOccurrenceFiltersV2,
  NotificationOccurrenceListV2Result,
  NotificationOccurrenceSnapshotV2,
  NotificationReadResult,
  NotificationSnapshot,
  NotificationStatusMutationResult,
  NotificationSubscribeInput,
  RenameSessionPayload,
  RestoreSessionPayload,
  SendMessagePayload,
  SendResult,
  SessionResult,
  StartSessionOptions,
  StartSessionPayload,
  StopWorkerPayload,
  WorkerRuntimeListV2Result,
} from './dto';

export interface HydraControlClient {
  // Board + lifecycle
  listSessions(): Promise<HydraSessionList>;
  listWorkerRuntimeV2(): Promise<WorkerRuntimeListV2Result>;
  createWorker(input: CreateWorkerInput): Promise<CreateWorkerResult>;
  createCopilot(input: CreateCopilotInput): Promise<CreateCopilotResult>;
  startSession(session: string, kind: SessionKind, options?: StartSessionOptions): Promise<SessionResult>;
  stopWorker(session: string): Promise<SessionResult>;
  deleteSession(session: string, kind: SessionKind, options?: DeleteSessionOptions): Promise<SessionResult>;
  renameSession(session: string, kind: SessionKind, name: string): Promise<SessionResult>;
  restoreSession(session: string): Promise<SessionResult>;

  // Terminal I/O by proxy
  getLogs(session: string, kind: SessionKind, lines?: number): Promise<LogResult>;
  sendMessage(session: string, kind: SessionKind, message: string): Promise<SendResult>;
  broadcastToWorkers(message: string): Promise<BroadcastResult>;

  // Attention inbox
  listNotifications(filters?: NotificationListFilters): Promise<NotificationListResult>;
  listNotificationOccurrencesV2(
    filters?: NotificationOccurrenceFiltersV2,
  ): Promise<NotificationOccurrenceListV2Result>;
  markNotificationRead(id: string): Promise<NotificationReadResult>;
  dismissNotification(id: string): Promise<NotificationStatusMutationResult>;
  clearNotifications(filters?: NotificationClearFilters): Promise<NotificationClearResult>;

  // Diff review (path-constrained)
  getDiff(session: string): Promise<DiffSummary>;
  getFileSnapshot(input: FileSnapshotInput): Promise<FileSnapshot>;

  // Git change counts for the sidebar (app-internal; code workers only, batched)
  listGitStatus(): Promise<GitStatusMap>;

  // Live push
  subscribeEvents(input?: EventSubscribeInput): AsyncIterable<HydraEvent>;
  subscribeNotifications(input?: NotificationSubscribeInput): AsyncIterable<NotificationSnapshot>;
  subscribeNotificationOccurrencesV2(
    filters?: NotificationOccurrenceFiltersV2,
  ): AsyncIterable<NotificationOccurrenceSnapshotV2>;

  // Terminal attach (high-privilege — its own transport method)
  attachTerminal(input: TerminalAttachInput): TerminalChannel;
}

/**
 * Build a `HydraControlClient` over any transport. `auth` (if given) is attached
 * to every call, so a renderer wires the launch token once and forgets it.
 */
export function createHydraControlClient(
  transport: HydraTransport,
  auth?: AuthContext,
): HydraControlClient {
  return {
    listSessions: () =>
      transport.request<undefined, HydraSessionList>(Op.listSessions, undefined, auth),

    listWorkerRuntimeV2: () =>
      transport.request<undefined, WorkerRuntimeListV2Result>(
        Op.listWorkerRuntimeV2, undefined, auth),

    createWorker: (input) =>
      transport.request<CreateWorkerInput, CreateWorkerResult>(Op.createWorker, input, auth),

    createCopilot: (input) =>
      transport.request<CreateCopilotInput, CreateCopilotResult>(Op.createCopilot, input, auth),

    startSession: (session, kind, options) =>
      transport.request<StartSessionPayload, SessionResult>(
        Op.startSession, { session, kind, options }, auth),

    stopWorker: (session) =>
      transport.request<StopWorkerPayload, SessionResult>(Op.stopWorker, { session }, auth),

    deleteSession: (session, kind, options) =>
      transport.request<DeleteSessionPayload, SessionResult>(
        Op.deleteSession, { session, kind, options }, auth),

    renameSession: (session, kind, name) =>
      transport.request<RenameSessionPayload, SessionResult>(
        Op.renameSession, { session, kind, name }, auth),

    restoreSession: (session) =>
      transport.request<RestoreSessionPayload, SessionResult>(Op.restoreSession, { session }, auth),

    getLogs: (session, kind, lines) =>
      transport.request<GetLogsPayload, LogResult>(Op.getLogs, { session, kind, lines }, auth),

    sendMessage: (session, kind, message) =>
      transport.request<SendMessagePayload, SendResult>(
        Op.sendMessage, { session, kind, message }, auth),

    broadcastToWorkers: (message) =>
      transport.request<BroadcastPayload, BroadcastResult>(Op.broadcastToWorkers, { message }, auth),

    listNotifications: (filters) =>
      transport.request<NotificationListFilters, NotificationListResult>(
        Op.listNotifications, filters ?? {}, auth),

    listNotificationOccurrencesV2: (filters) =>
      transport.request<NotificationOccurrenceFiltersV2, NotificationOccurrenceListV2Result>(
        Op.listNotificationOccurrencesV2, filters ?? {}, auth),

    markNotificationRead: (id) =>
      transport.request<MarkNotificationReadPayload, NotificationReadResult>(
        Op.markNotificationRead, { id }, auth),

    dismissNotification: (id) =>
      transport.request<DismissNotificationPayload, NotificationStatusMutationResult>(
        Op.dismissNotification, { id }, auth),

    clearNotifications: (filters) =>
      transport.request<NotificationClearFilters, NotificationClearResult>(
        Op.clearNotifications, filters ?? {}, auth),

    getDiff: (session) =>
      transport.request<GetDiffPayload, DiffSummary>(Op.getDiff, { session }, auth),

    getFileSnapshot: (input) =>
      transport.request<FileSnapshotInput, FileSnapshot>(Op.getFileSnapshot, input, auth),

    listGitStatus: () =>
      transport.request<undefined, GitStatusMap>(Op.getGitStatus, undefined, auth),

    subscribeEvents: (input) =>
      transport.stream<EventSubscribeInput, HydraEvent>(Topic.events, input ?? {}, auth),

    subscribeNotifications: (input) =>
      transport.stream<NotificationSubscribeInput, NotificationSnapshot>(
        Topic.notifications, (input ?? {}) as NotificationSubscribeInput, auth),

    subscribeNotificationOccurrencesV2: (filters) =>
      transport.stream<NotificationOccurrenceFiltersV2, NotificationOccurrenceSnapshotV2>(
        Topic.notificationOccurrencesV2, filters ?? {}, auth),

    attachTerminal: (input) =>
      transport.openTerminal(input, auth),
  };
}
