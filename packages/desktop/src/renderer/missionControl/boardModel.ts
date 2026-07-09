// The pure, headless board model for Mission Control — the "snapshot + event
// delta" engine (FINAL.md §1). `listSessions()` gives the authoritative base;
// the event and notification streams overlay LIVE deltas on top of it without a
// refetch. Everything here is a pure function of (state, input): no React, no
// DOM, no transport — so the exact reducer the hook drives is also unit-testable
// headlessly (see scripts/missionControlBoardSmoke.mjs).
//
// Runtime status is ALWAYS taken from the runtime store (snapshot) or the
// `worker.runtime.changed` event — never inferred from terminal text.

import type {
  CopilotMode,
  HydraEvent,
  HydraNotification,
  HydraSessionList,
  NotificationSnapshot,
  SessionListCopilot,
  SessionListWorker,
  WorkerRuntimeCliSnapshot,
  WorkerRuntimeState,
} from '@hydra/protocol';

export type TileLifecycle = 'running' | 'stopped';

/** The immutable board state: the last snapshot plus live overlays. */
export interface BoardModel {
  /** Last authoritative snapshot from `listSessions()`. */
  readonly snapshot: HydraSessionList;
  /** Live runtime projections keyed by session (from `worker.runtime.changed`). */
  readonly runtimeOverrides: Readonly<Record<string, WorkerRuntimeCliSnapshot>>;
  /** Live lifecycle overrides keyed by session (from `*.started` / `*.stopped`). */
  readonly lifecycleOverrides: Readonly<Record<string, TileLifecycle>>;
  /** Unread notification count per session (target ∪ source), from the notification stream. */
  readonly unreadBySession: Readonly<Record<string, number>>;
  /**
   * Sessions whose latest UNREAD notification is a `complete` — the LIGHT
   * completed chip (mirrors the old tree's `complete → 'completed'`). Folded
   * from the notification snapshot and cleared when a session goes back to
   * running (see `applyEvent`).
   */
  readonly completedBySession: Readonly<Record<string, boolean>>;
  /**
   * Changed-file counts per CODE worker (`git status --porcelain` line count),
   * polled off the board tick via `applyGitStatus`. Task workers / copilots
   * never appear here, so they never render `U:N`.
   */
  readonly gitStatusBySession: Readonly<Record<string, number>>;
  /** Total unread across all notifications (authoritative from the snapshot). */
  readonly unreadTotal: number;
  /** Complete notifications keyed by target session, used for copilot child rows. */
  readonly completionNotificationsByTargetSession: Readonly<Record<string, readonly CompletionNotificationModel[]>>;
  /** ISO timestamp of the most recent event touching each session. */
  readonly lastEventBySession: Readonly<Record<string, string>>;
  /** Highest event `seq` applied — the live cursor. */
  readonly lastSeq: number;
  /**
   * Bumped whenever a membership-changing event lands (create / delete /
   * restore). The hook watches this and refetches `listSessions()`, because such
   * events do not carry a full tile DTO — only the authoritative list does.
   */
  readonly resyncToken: number;
}

// ── event classification ──
//
// Membership events change the SET of sessions; they carry no full tile DTO, so
// they trigger a `listSessions()` resync rather than an in-place edit.
const MEMBERSHIP_EVENTS = new Set<string>([
  'worker.created',
  'worker.deleted',
  'worker.restored',
  'copilot.created',
  'copilot.deleted',
  'copilot.restored',
]);

const STARTED_EVENTS = new Set<string>(['worker.started', 'copilot.started']);
const STOPPED_EVENTS = new Set<string>(['worker.stopped', 'copilot.stopped']);

const RUNTIME_STATES: ReadonlySet<string> = new Set<WorkerRuntimeState>([
  'unknown',
  'running',
  'idle',
  'needs-input',
  'error',
]);

/** True for events that change the SET of sessions and thus require a resync. */
export function isMembershipEvent(type: string): boolean {
  return MEMBERSHIP_EVENTS.has(type);
}

/** Build a fresh board from a `listSessions()` snapshot. */
export function createBoardModel(snapshot: HydraSessionList): BoardModel {
  return {
    snapshot,
    runtimeOverrides: {},
    lifecycleOverrides: {},
    unreadBySession: {},
    completedBySession: {},
    gitStatusBySession: {},
    unreadTotal: 0,
    completionNotificationsByTargetSession: {},
    lastEventBySession: {},
    lastSeq: 0,
    resyncToken: 0,
  };
}

/**
 * Replace the authoritative base after a resync. Overlays that the fresh
 * snapshot now folds in (runtime + lifecycle, read from the same stores) are
 * dropped; the notification-derived and last-event overlays are pruned to the
 * surviving sessions so stale sessions cannot leak counts.
 */
export function applySnapshot(model: BoardModel, snapshot: HydraSessionList): BoardModel {
  const alive = collectSessions(snapshot);
  return {
    ...model,
    snapshot,
    runtimeOverrides: {},
    lifecycleOverrides: {},
    unreadBySession: pruneToSessions(model.unreadBySession, alive),
    completedBySession: pruneToSessions(model.completedBySession, alive),
    gitStatusBySession: pruneToSessions(model.gitStatusBySession, alive),
    completionNotificationsByTargetSession: pruneToSessions(model.completionNotificationsByTargetSession, alive),
    lastEventBySession: pruneToSessions(model.lastEventBySession, alive),
  };
}

/** Apply one event delta. Pure; returns the same reference when nothing changes. */
export function applyEvent(model: BoardModel, event: HydraEvent): BoardModel {
  if (typeof event.seq !== 'number') {
    return model;
  }

  const next: Mutable<BoardModel> = { ...model };
  next.lastSeq = Math.max(model.lastSeq, event.seq);

  // Stamp last-event time (events arrive in ascending seq order → latest wins).
  if (event.session && typeof event.ts === 'string') {
    next.lastEventBySession = { ...model.lastEventBySession, [event.session]: event.ts };
  }

  if (MEMBERSHIP_EVENTS.has(event.type)) {
    next.resyncToken = model.resyncToken + 1;
    return next;
  }

  if (event.session && event.type === 'worker.runtime.changed') {
    const projection = runtimeFromEvent(event);
    if (projection) {
      next.runtimeOverrides = { ...model.runtimeOverrides, [event.session]: projection };
      // A worker that resumes work is no longer "completed" — drop the chip the
      // instant it runs again, without waiting for the next notification snapshot.
      if (projection.state === 'running') {
        next.completedBySession = withoutSession(model.completedBySession, event.session);
      }
    }
    return next;
  }

  if (event.session && STARTED_EVENTS.has(event.type)) {
    next.lifecycleOverrides = { ...model.lifecycleOverrides, [event.session]: 'running' };
    next.completedBySession = withoutSession(model.completedBySession, event.session);
    return next;
  }

  if (event.session && STOPPED_EVENTS.has(event.type)) {
    next.lifecycleOverrides = { ...model.lifecycleOverrides, [event.session]: 'stopped' };
    return next;
  }

  return next;
}

/** Apply a batch of events in order — one new model, one render. */
export function applyEvents(model: BoardModel, events: readonly HydraEvent[]): BoardModel {
  return events.reduce(applyEvent, model);
}

/**
 * Fold a notification snapshot into per-session unread counts AND the per-session
 * completion flag. A session is "completed" when its most recent notification
 * (read OR unread, by `createdAt`) is of kind `complete` — so the chip PERSISTS
 * after you glance at the notification, and is cleared only when the session
 * resumes running (see the `worker.runtime.changed` handler). Mirrors the old
 * tree's persistent `complete → 'completed'`.
 */
export function applyNotificationSnapshot(model: BoardModel, snapshot: NotificationSnapshot): BoardModel {
  const unreadBySession: Record<string, number> = {};
  // Newest notification (read or unread) per session → drives the completed chip.
  const latestBySession = new Map<string, { at: number; kind: string }>();
  const completionNotificationsByTargetSession: Record<string, CompletionNotificationModel[]> = {};

  for (const notification of snapshot.notifications) {
    // Count / classify a notification once per distinct session it references
    // (mirrors the engine's `bySession` index — target ∪ source).
    const sessions = new Set<string>();
    if (notification.targetSession) {
      sessions.add(notification.targetSession);
    }
    if (notification.sourceSession) {
      sessions.add(notification.sourceSession);
    }
    const at = Date.parse(notification.createdAt);
    const unread = notification.readAt === null;
    for (const session of sessions) {
      if (unread) {
        unreadBySession[session] = (unreadBySession[session] ?? 0) + 1;
      }
      const current = latestBySession.get(session);
      if (!current || (Number.isFinite(at) && at >= current.at)) {
        latestBySession.set(session, { at: Number.isFinite(at) ? at : 0, kind: notification.kind });
      }
    }
    if (notification.kind === 'complete' && notification.targetSession) {
      const targetSession = notification.targetSession;
      const bucket = completionNotificationsByTargetSession[targetSession] ?? [];
      bucket.push(toCompletionNotificationModel(notification));
      completionNotificationsByTargetSession[targetSession] = bucket;
    }
  }

  const completedBySession: Record<string, boolean> = {};
  for (const [session, latest] of latestBySession) {
    if (latest.kind === 'complete') {
      completedBySession[session] = true;
    }
  }

  return {
    ...model,
    unreadBySession,
    completedBySession,
    completionNotificationsByTargetSession,
    unreadTotal: snapshot.unreadCount,
  };
}

/**
 * Fold a batch of git-status counts (from the ~15s poll) into the board. The
 * map replaces the previous counts wholesale, so deleted workers drop out with
 * no stale `U:N` left behind.
 */
export function applyGitStatus(
  model: BoardModel,
  statuses: Readonly<Record<string, { changed: number }>>,
): BoardModel {
  const gitStatusBySession: Record<string, number> = {};
  for (const [session, status] of Object.entries(statuses)) {
    gitStatusBySession[session] = status.changed;
  }
  return { ...model, gitStatusBySession };
}

// ── selectors (snapshot + overlays → renderable view) ──

export interface WorkerTileModel {
  readonly kind: 'worker';
  readonly session: string;
  readonly number: number;
  readonly name: string;
  readonly type: 'code' | 'task';
  readonly repo: string | null;
  readonly branch: string | null;
  readonly agent: string;
  readonly lifecycle: TileLifecycle;
  readonly runtime: WorkerRuntimeState;
  readonly runtimeReason: string | null;
  readonly unread: number;
  /** Latest stored notification is a `complete` (and the worker isn't running). */
  readonly completed: boolean;
  /**
   * `git status --porcelain` changed-file count for CODE workers, or `null`
   * when unknown / not applicable (task workers, not yet polled). Hidden at 0.
   */
  readonly changed: number | null;
  readonly lastEventAt: string | null;
  readonly attached: boolean;
  readonly workdir: string | null;
  readonly copilotSessionName: string | null;
  readonly raw: SessionListWorker;
}

export interface CopilotTileModel {
  readonly kind: 'copilot';
  readonly session: string;
  readonly name: string;
  readonly agent: string;
  readonly mode: CopilotMode;
  readonly lifecycle: TileLifecycle;
  readonly unread: number;
  /** Latest stored notification targeting the copilot is a `complete`. */
  readonly completed: boolean;
  /** Complete notifications targeting this copilot, newest first. */
  readonly completionNotifications: readonly CompletionNotificationModel[];
  /** Number of workers this copilot manages (`copilotSessionName` match). */
  readonly workerCount: number;
  /** Distinct repos among those workers (task workers contribute none). */
  readonly repoCount: number;
  readonly lastEventAt: string | null;
  readonly attached: boolean;
  readonly workdir: string | null;
  readonly raw: SessionListCopilot;
}

export type TileModel = WorkerTileModel | CopilotTileModel;

export interface CompletionNotificationModel {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly targetSession: string;
  readonly sourceSession: string | null;
  readonly actionSession: string | null;
}

export type BoardGroupKind = 'repo' | 'tasks' | 'copilots';

export interface BoardGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: BoardGroupKind;
  readonly tiles: readonly TileModel[];
  /** Tiles in a `needs-input` / `error` runtime state. */
  readonly attentionCount: number;
  /** Sum of unread across the group's tiles. */
  readonly unreadCount: number;
}

export interface BoardView {
  readonly groups: readonly BoardGroup[];
  readonly workerCount: number;
  readonly copilotCount: number;
  readonly unreadTotal: number;
  readonly attentionTotal: number;
}

const LOCAL_TASKS_LABEL = 'Local Tasks';
const COPILOTS_LABEL = 'Copilots';
const UNKNOWN_REPO_LABEL = 'Unknown repo';

/** Project the model into grouped, sorted tiles ready to render. */
export function selectBoard(model: BoardModel): BoardView {
  const copilotSummaries = computeCopilotSummaries(model.snapshot.workers);
  const workerTiles = model.snapshot.workers.map((worker) => toWorkerTile(model, worker));
  const copilotTiles = model.snapshot.copilots.map((copilot) =>
    toCopilotTile(model, copilot, copilotSummaries.get(copilot.session)),
  );

  const repoGroups = new Map<string, WorkerTileModel[]>();
  const taskTiles: WorkerTileModel[] = [];
  for (const tile of workerTiles) {
    if (tile.type === 'task') {
      taskTiles.push(tile);
      continue;
    }
    const repoKey = tile.repo ?? UNKNOWN_REPO_LABEL;
    const bucket = repoGroups.get(repoKey);
    if (bucket) {
      bucket.push(tile);
    } else {
      repoGroups.set(repoKey, [tile]);
    }
  }

  const groups: BoardGroup[] = [];
  for (const repoKey of [...repoGroups.keys()].sort((a, b) => a.localeCompare(b))) {
    const tiles = repoGroups.get(repoKey)!.sort(byWorkerNumber);
    groups.push(buildGroup(`repo:${repoKey}`, repoLabel(repoKey), 'repo', tiles));
  }
  if (taskTiles.length > 0) {
    groups.push(buildGroup('tasks', LOCAL_TASKS_LABEL, 'tasks', taskTiles.sort(byWorkerNumber)));
  }
  if (copilotTiles.length > 0) {
    groups.push(
      buildGroup('copilots', COPILOTS_LABEL, 'copilots', copilotTiles.sort(byName)),
    );
  }

  return {
    groups,
    workerCount: workerTiles.length,
    copilotCount: copilotTiles.length,
    unreadTotal: model.unreadTotal,
    attentionTotal: groups.reduce((sum, group) => sum + group.attentionCount, 0),
  };
}

// ── internals ──

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Per-copilot worker/repo tally, mirroring the old `buildCopilotWorkerSummaries`. */
interface CopilotSummary {
  workerCount: number;
  repoCount: number;
}

/**
 * Tally each copilot's managed workers and the distinct repos among them, keyed
 * by copilot session. Workers with no `copilotSessionName` are ignored; task
 * workers count toward `workerCount` but contribute no repo (matching the old
 * tree's `[N workers · M repos]`).
 */
function computeCopilotSummaries(workers: readonly SessionListWorker[]): Map<string, CopilotSummary> {
  const byCopilot = new Map<string, { workerCount: number; repos: Set<string> }>();
  for (const worker of workers) {
    const copilotSession = worker.copilotSessionName;
    if (!copilotSession) {
      continue;
    }
    let entry = byCopilot.get(copilotSession);
    if (!entry) {
      entry = { workerCount: 0, repos: new Set<string>() };
      byCopilot.set(copilotSession, entry);
    }
    entry.workerCount += 1;
    if (worker.repo) {
      entry.repos.add(worker.repo);
    }
  }

  const summaries = new Map<string, CopilotSummary>();
  for (const [session, entry] of byCopilot) {
    summaries.set(session, { workerCount: entry.workerCount, repoCount: entry.repos.size });
  }
  return summaries;
}

/** Immutably drop one key from a session-keyed record (returns same ref if absent). */
function withoutSession<T>(
  record: Readonly<Record<string, T>>,
  session: string,
): Readonly<Record<string, T>> {
  if (!(session in record)) {
    return record;
  }
  const next: Record<string, T> = { ...record };
  delete next[session];
  return next;
}

function toWorkerTile(model: BoardModel, worker: SessionListWorker): WorkerTileModel {
  const override = model.runtimeOverrides[worker.session];
  const lifecycle = model.lifecycleOverrides[worker.session] ?? deriveLifecycle(worker.status);
  // A stopped worker has no live runtime; force `unknown` so a stale override
  // does not claim a dead session is "running".
  const runtimeSource = lifecycle === 'stopped' ? undefined : override ?? worker.runtimeState;
  const runtime = runtimeSource ? runtimeSource.state : 'unknown';
  return {
    kind: 'worker',
    session: worker.session,
    number: worker.number,
    name: worker.name,
    type: worker.type,
    repo: worker.repo,
    branch: worker.branch,
    agent: worker.agent,
    lifecycle,
    runtime,
    runtimeReason: runtimeSource?.reason ?? null,
    unread: model.unreadBySession[worker.session] ?? 0,
    // The chip lingers only while the worker is NOT running; a live snapshot can
    // still hold a `complete` for a resumed worker until its notif is read.
    completed: (model.completedBySession[worker.session] ?? false) && runtime !== 'running',
    changed: worker.type === 'code' ? (model.gitStatusBySession[worker.session] ?? null) : null,
    lastEventAt: model.lastEventBySession[worker.session] ?? worker.runtimeState.updatedAt,
    attached: worker.attached,
    workdir: worker.workdir,
    copilotSessionName: worker.copilotSessionName,
    raw: worker,
  };
}

function toCopilotTile(
  model: BoardModel,
  copilot: SessionListCopilot,
  summary: CopilotSummary | undefined,
): CopilotTileModel {
  return {
    kind: 'copilot',
    session: copilot.session,
    name: copilot.name,
    agent: copilot.agent,
    mode: copilot.mode,
    lifecycle: model.lifecycleOverrides[copilot.session] ?? deriveLifecycle(copilot.status),
    unread: model.unreadBySession[copilot.session] ?? 0,
    completed: model.completedBySession[copilot.session] ?? false,
    completionNotifications: model.completionNotificationsByTargetSession[copilot.session] ?? [],
    workerCount: summary?.workerCount ?? 0,
    repoCount: summary?.repoCount ?? 0,
    lastEventAt: model.lastEventBySession[copilot.session] ?? null,
    attached: copilot.attached,
    workdir: copilot.workdir,
    raw: copilot,
  };
}

function toCompletionNotificationModel(notification: HydraNotification): CompletionNotificationModel {
  return {
    id: notification.id,
    title: notification.title,
    createdAt: notification.createdAt,
    targetSession: notification.targetSession ?? '',
    sourceSession: notification.sourceSession,
    actionSession: notification.action?.session ?? notification.sourceSession,
  };
}

function buildGroup(
  key: string,
  label: string,
  kind: BoardGroupKind,
  tiles: readonly TileModel[],
): BoardGroup {
  let attentionCount = 0;
  let unreadCount = 0;
  for (const tile of tiles) {
    if (tile.kind === 'worker' && (tile.runtime === 'needs-input' || tile.runtime === 'error')) {
      attentionCount += 1;
    }
    unreadCount += tile.unread;
  }
  return { key, label, kind, tiles, attentionCount, unreadCount };
}

/** Lifecycle is the tmux truth: only `stopped` is stopped, everything else runs. */
export function deriveLifecycle(status: string): TileLifecycle {
  return status === 'stopped' ? 'stopped' : 'running';
}

function runtimeFromEvent(event: HydraEvent): WorkerRuntimeCliSnapshot | null {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const state = payload.state;
  if (typeof state !== 'string' || !RUNTIME_STATES.has(state)) {
    return null;
  }
  return {
    state: state as WorkerRuntimeState,
    updatedAt: readString(payload.updatedAt) ?? event.ts ?? null,
    origin: (readString(payload.origin) as WorkerRuntimeCliSnapshot['origin']) ?? 'session-manager',
    reason: readString(payload.reason) ?? undefined,
    notificationId: readString(payload.notificationId) ?? undefined,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function collectSessions(snapshot: HydraSessionList): Set<string> {
  const sessions = new Set<string>();
  for (const worker of snapshot.workers) {
    sessions.add(worker.session);
  }
  for (const copilot of snapshot.copilots) {
    sessions.add(copilot.session);
  }
  return sessions;
}

function pruneToSessions<T>(
  record: Readonly<Record<string, T>>,
  alive: ReadonlySet<string>,
): Readonly<Record<string, T>> {
  let changed = false;
  const pruned: Record<string, T> = {};
  for (const [session, value] of Object.entries(record)) {
    if (alive.has(session)) {
      pruned[session] = value;
    } else {
      changed = true;
    }
  }
  return changed ? pruned : record;
}

function repoLabel(repoKey: string): string {
  if (repoKey === UNKNOWN_REPO_LABEL) {
    return repoKey;
  }
  const trimmed = repoKey.replace(/[/\\]+$/, '');
  const segment = trimmed.split(/[/\\]/).pop();
  return segment && segment.length > 0 ? segment : repoKey;
}

function byWorkerNumber(a: WorkerTileModel, b: WorkerTileModel): number {
  return a.number - b.number || a.name.localeCompare(b.name);
}

function byName(a: TileModel, b: TileModel): number {
  return a.name.localeCompare(b.name);
}
