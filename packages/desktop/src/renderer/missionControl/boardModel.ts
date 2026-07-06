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
  /** Total unread across all notifications (authoritative from the snapshot). */
  readonly unreadTotal: number;
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
    unreadTotal: 0,
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
    }
    return next;
  }

  if (event.session && STARTED_EVENTS.has(event.type)) {
    next.lifecycleOverrides = { ...model.lifecycleOverrides, [event.session]: 'running' };
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

/** Fold a notification snapshot into per-session unread counts. */
export function applyNotificationSnapshot(model: BoardModel, snapshot: NotificationSnapshot): BoardModel {
  const unreadBySession: Record<string, number> = {};
  for (const notification of snapshot.notifications) {
    if (notification.readAt !== null) {
      continue;
    }
    // Count a notification once per distinct session it references (mirrors the
    // engine's `bySession` index).
    const sessions = new Set<string>();
    if (notification.targetSession) {
      sessions.add(notification.targetSession);
    }
    if (notification.sourceSession) {
      sessions.add(notification.sourceSession);
    }
    for (const session of sessions) {
      unreadBySession[session] = (unreadBySession[session] ?? 0) + 1;
    }
  }
  return { ...model, unreadBySession, unreadTotal: snapshot.unreadCount };
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
  readonly lastEventAt: string | null;
  readonly attached: boolean;
  readonly workdir: string | null;
  readonly raw: SessionListCopilot;
}

export type TileModel = WorkerTileModel | CopilotTileModel;

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
  const workerTiles = model.snapshot.workers.map((worker) => toWorkerTile(model, worker));
  const copilotTiles = model.snapshot.copilots.map((copilot) => toCopilotTile(model, copilot));

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

function toWorkerTile(model: BoardModel, worker: SessionListWorker): WorkerTileModel {
  const override = model.runtimeOverrides[worker.session];
  const lifecycle = model.lifecycleOverrides[worker.session] ?? deriveLifecycle(worker.status);
  // A stopped worker has no live runtime; force `unknown` so a stale override
  // does not claim a dead session is "running".
  const runtimeSource = lifecycle === 'stopped' ? undefined : override ?? worker.runtimeState;
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
    runtime: runtimeSource ? runtimeSource.state : 'unknown',
    runtimeReason: runtimeSource?.reason ?? null,
    unread: model.unreadBySession[worker.session] ?? 0,
    lastEventAt: model.lastEventBySession[worker.session] ?? worker.runtimeState.updatedAt,
    attached: worker.attached,
    workdir: worker.workdir,
    copilotSessionName: worker.copilotSessionName,
    raw: worker,
  };
}

function toCopilotTile(model: BoardModel, copilot: SessionListCopilot): CopilotTileModel {
  return {
    kind: 'copilot',
    session: copilot.session,
    name: copilot.name,
    agent: copilot.agent,
    mode: copilot.mode,
    lifecycle: model.lifecycleOverrides[copilot.session] ?? deriveLifecycle(copilot.status),
    unread: model.unreadBySession[copilot.session] ?? 0,
    lastEventAt: model.lastEventBySession[copilot.session] ?? null,
    attached: copilot.attached,
    workdir: copilot.workdir,
    raw: copilot,
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
