// Request/result DTOs for every HydraControlClient verb.
//
// Two rules govern this file (brief §1 + Definition of done):
//   1. Field names equal the CLI JSON field names (docs/cli-contract.md), so
//      the desktop app, CLI scripts, and copilots speak one domain language.
//      The `protocolContractSmoke` guards this against the doc.
//   2. Reuse @hydra/core types wherever the engine already defines a shape
//      (WorkerRuntimeState, HydraEvent, HydraNotification, …). All @hydra/core
//      imports are `import type` — fully erased, so this package pulls in ZERO
//      engine runtime code and stays transport-agnostic.

import type { CopilotMode } from '@hydra/core/types';
import type {
  WorkerRuntimeState,
  WorkerRuntimeSignalOrigin,
} from '@hydra/core/workerRuntimeState';
import type { HydraEvent } from '@hydra/core/events';
import type {
  HydraNotification,
  NotificationClearFilters,
  NotificationListFilters,
  NotificationListResult,
  NotificationReadResult,
  NotificationClearResult,
} from '@hydra/core/notifications';
import type { NotificationSnapshot } from '@hydra/core/notificationState';
import type { DiffChange } from '@hydra/core/diff';
import type { SessionKind } from './types';

// Re-export the reused engine types so the renderer imports its entire domain
// vocabulary from `@hydra/protocol` alone.
export type {
  CopilotMode,
  WorkerRuntimeState,
  WorkerRuntimeSignalOrigin,
  HydraEvent,
  HydraNotification,
  NotificationClearFilters,
  NotificationListFilters,
  NotificationListResult,
  NotificationReadResult,
  NotificationClearResult,
  NotificationSnapshot,
  DiffChange,
};

// ── listSessions ── (mirrors `hydra list --json`, packages/cli .../list.ts)

/** Runtime projection block, identical to the CLI `runtimeState` object. */
export interface WorkerRuntimeCliSnapshot {
  state: WorkerRuntimeState;
  updatedAt: string | null;
  origin: WorkerRuntimeSignalOrigin;
  reason?: string;
  notificationId?: string;
}

export interface SessionListCopilot {
  name: string;
  session: string;
  agent: string;
  mode: CopilotMode;
  status: string;
  attached: boolean;
  workdir: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  agentSessionId: string | null;
}

export interface SessionListWorker {
  number: number;
  name: string;
  type: 'code' | 'task';
  session: string;
  repo: string | null;
  branch: string | null;
  agent: string;
  status: string;
  runtimeState: WorkerRuntimeCliSnapshot;
  attached: boolean;
  workdir: string | null;
  managedWorkdir: boolean;
  copilotSessionName: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  agentSessionId: string | null;
}

export interface HydraSessionList {
  copilots: SessionListCopilot[];
  workers: SessionListWorker[];
  count: number;
}

// ── createWorker ── (mirrors `hydra worker create`)

/**
 * Code worker: set `repo` + `branch`. Task worker: set `dir`, or `temp` +
 * `name`. Field names mirror the CLI flags exactly.
 */
export interface CreateWorkerInput {
  repo?: string;
  branch?: string;
  dir?: string;
  temp?: boolean;
  name?: string;
  agent?: string;
  base?: string;
  task?: string;
  taskFile?: string;
  copilot?: string;
  notifyCopilot?: boolean;
}

export interface CreateWorkerResult {
  status: 'created' | 'exists';
  type: 'code' | 'task';
  session: string;
  branch: string | null;
  name: string;
  agent: string;
  workdir: string;
  managedWorkdir: boolean;
}

// ── createCopilot ── (mirrors `hydra copilot create`)

export interface CreateCopilotInput {
  workdir?: string;
  repo?: string;
  agent?: string;
  mode?: CopilotMode;
  plan?: boolean;
  name?: string;
  session?: string;
}

export interface CreateCopilotResult {
  status: 'created';
  session: string;
  agent: string;
  mode: CopilotMode;
  workdir: string;
  agentSessionId: string | null;
}

// ── start / stop / delete / rename / restore ──

export interface StartSessionOptions {
  agent?: string;
  agentCommand?: string;
}

export interface DeleteSessionOptions {
  deleteFiles?: boolean;
}

/**
 * Shared mutation result for the lifecycle verbs. `status` discriminates which
 * verb produced it (`started`/`stopped`/`deleted`/`renamed`/`restored`); the
 * remaining fields mirror the corresponding CLI command's JSON and are present
 * only when that command includes them.
 */
export interface SessionResult {
  status: string;
  session: string;
  kind: SessionKind;
  agent?: string;
  workdir?: string;
  branch?: string | null;
  oldSession?: string;
  newSession?: string;
  deleteFiles?: boolean;
  type?: SessionKind;
  workerType?: 'code' | 'task';
  name?: string;
  mode?: CopilotMode;
  agentSessionId?: string | null;
}

// ── logs / send / broadcast ── (mirror `hydra worker logs` / `send`)

export interface LogResult {
  session: string;
  lines: number;
  output: string;
  sessionId: string | null;
  sessionFile: string | null;
}

export interface SendResult {
  status: 'sent';
  session: string;
  message: string;
}

export interface BroadcastResult {
  status: 'sent';
  sessions: string[];
  message: string;
}

// ── diff / file snapshot ── (headless DiffService, path-constrained)

export interface DiffSummary {
  session: string;
  workdir: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  changes: DiffChange[];
  count: number;
}

export type DiffSide = 'base' | 'current';

export interface FileSnapshotInput {
  session: string;
  /** Path relative to the session workdir. Absolute paths / `..` are rejected. */
  path: string;
  side?: DiffSide;
}

export interface FileSnapshot {
  session: string;
  path: string;
  side: DiffSide;
  ref?: string;
  content: string;
  exists: boolean;
}

// ── gitStatus ── (APP-INTERNAL: not a CLI verb, absent from cli-contract.md)
//
// Powers the sidebar `U:N` token. The sidecar runs `git status --porcelain` in
// each CODE worker's worktree and returns the changed-file count; task workers
// and copilots are skipped. The renderer polls this on an interval, so it is a
// board OVERLAY, never part of the listSessions snapshot.

export interface GitChangeStatus {
  /** `git status --porcelain` line count: modified + added + untracked. */
  changed: number;
}

/** Keyed by session; only code workers with a worktree appear. */
export type GitStatusMap = Record<string, GitChangeStatus>;

// ── streams ──

export interface EventSubscribeInput {
  /** Only stream events with `seq` greater than this cursor. */
  after?: number;
}

// Reserved for future filters (e.g. by session); empty today.
export type NotificationSubscribeInput = Record<string, never>;

// ── wire request payloads ──
//
// The envelope each `transport.request(op, payload)` carries. Defined once here
// so the client that builds them and the HydraAppService that destructures them
// cannot drift. Verb inputs (CreateWorkerInput, filters, …) are reused directly
// where they already are the payload.

export interface StartSessionPayload {
  session: string;
  kind: SessionKind;
  options?: StartSessionOptions;
}

export interface StopWorkerPayload {
  session: string;
}

export interface DeleteSessionPayload {
  session: string;
  kind: SessionKind;
  options?: DeleteSessionOptions;
}

export interface RenameSessionPayload {
  session: string;
  kind: SessionKind;
  name: string;
}

export interface RestoreSessionPayload {
  session: string;
}

export interface GetLogsPayload {
  session: string;
  kind: SessionKind;
  lines?: number;
}

export interface SendMessagePayload {
  session: string;
  kind: SessionKind;
  message: string;
}

export interface BroadcastPayload {
  message: string;
}

export interface MarkNotificationReadPayload {
  id: string;
}

export interface GetDiffPayload {
  session: string;
}
