import type {
  CopilotMode,
  HydraNotificationV2,
  SessionListCopilot,
  SessionListWorker,
  WorkerRuntimeSnapshotV2,
  WorkerRuntimeState,
} from '@hydra/protocol';

import type {
  BoardGroup,
  BoardView,
  CompletionNotificationModel,
  CopilotTileModel,
  InboxNotificationModel,
  TileLifecycle,
  WorkerTileModel,
} from '../missionControl/boardModel';
import type { DesktopControlModel } from './model';

export interface WorkerControlRow {
  readonly kind: 'worker';
  readonly workerId: number;
  readonly session: string;
  readonly name: string;
  readonly type: 'code' | 'task';
  readonly repo: string | null;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly agent: string;
  readonly lifecycle: TileLifecycle;
  readonly runtime: WorkerRuntimeSnapshotV2 | null;
  readonly runtimeState: WorkerRuntimeState;
  readonly runtimeReason: string | null;
  readonly unreadCount: number;
  readonly activeAttentionCount: number;
  readonly completed: boolean;
  readonly changed: number | null;
  readonly attached: boolean;
  readonly workdir: string | null;
  readonly parentCopilotSession: string | null;
  readonly occurrences: readonly HydraNotificationV2[];
  readonly raw: SessionListWorker;
}

export interface CopilotControlRow {
  readonly kind: 'copilot';
  readonly session: string;
  readonly name: string;
  readonly agent: string;
  readonly mode: CopilotMode;
  readonly lifecycle: TileLifecycle;
  readonly unreadCount: number;
  readonly activeAttentionCount: number;
  readonly workerCount: number;
  readonly repoCount: number;
  readonly managedWorkerIds: readonly number[];
  readonly workers: readonly WorkerControlRow[];
  readonly occurrences: readonly HydraNotificationV2[];
  readonly attached: boolean;
  readonly workdir: string | null;
  readonly raw: SessionListCopilot;
}

export interface WorkerControlGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: 'repository' | 'local-tasks';
  readonly workers: readonly WorkerControlRow[];
  readonly unreadCount: number;
  readonly activeAttentionCount: number;
}

export interface AttentionControlRow {
  readonly occurrence: HydraNotificationV2;
  readonly worker: WorkerControlRow | null;
  readonly priority: number;
  readonly routeSession: string | null;
}

export interface SessionHeaderModel {
  readonly kind: 'worker' | 'copilot';
  readonly session: string;
  readonly name: string;
  readonly lifecycle: TileLifecycle;
  readonly runtimeState: WorkerRuntimeState | null;
  readonly unreadCount: number;
  readonly activeAttentionCount: number;
  readonly agent: string;
  readonly workdir: string | null;
}

export interface WorkerContextModel {
  readonly worker: WorkerControlRow;
  readonly parentCopilot: CopilotControlRow | null;
  readonly occurrences: readonly HydraNotificationV2[];
}

export interface CopilotContextModel {
  readonly copilot: CopilotControlRow;
  readonly workers: readonly WorkerControlRow[];
  readonly occurrences: readonly HydraNotificationV2[];
}

export interface DesktopControlView {
  readonly copilots: readonly CopilotControlRow[];
  readonly workers: readonly WorkerControlRow[];
  readonly workerGroups: readonly WorkerControlGroup[];
  readonly attention: readonly AttentionControlRow[];
  readonly unreadTotal: number;
  readonly activeAttentionTotal: number;
}

const LOCAL_TASKS_LABEL = 'Local Tasks';
const UNKNOWN_REPO_LABEL = 'Unknown repo';

export function selectDesktopControlView(model: DesktopControlModel): DesktopControlView {
  const workers = model.sessions.workers
    .map(worker => toWorkerControlRow(model, worker))
    .sort(byWorkerNumber);
  const workersById = new Map(workers.map(worker => [worker.workerId, worker]));
  const copilots = model.sessions.copilots
    .map(copilot => toCopilotControlRow(model, copilot, workers))
    .sort((left, right) => left.name.localeCompare(right.name));
  const workerGroups = buildWorkerGroups(workers);
  const attention = selectAttentionRows(model, workersById);
  return {
    copilots,
    workers,
    workerGroups,
    attention,
    unreadTotal: countUnread(model.occurrencesById.values()),
    activeAttentionTotal: attention.length,
  };
}

export function selectAttentionRows(
  model: DesktopControlModel,
  workersById?: ReadonlyMap<number, WorkerControlRow>,
): AttentionControlRow[] {
  const resolvedWorkers = workersById ?? new Map(
    model.sessions.workers.map(worker => {
      const row = toWorkerControlRow(model, worker);
      return [row.workerId, row] as const;
    }),
  );
  const byOccurrenceId = new Map<string, HydraNotificationV2>();
  for (const occurrence of model.occurrencesById.values()) {
    if (!isAttentionOccurrence(occurrence)) continue;
    const existing = byOccurrenceId.get(occurrence.occurrenceId);
    if (!existing || compareNewestFirst(occurrence, existing) < 0) {
      byOccurrenceId.set(occurrence.occurrenceId, occurrence);
    }
  }
  return [...byOccurrenceId.values()]
    .map(occurrence => {
      const worker = resolvedWorkers.get(occurrence.workerId) ?? null;
      return {
        occurrence: cloneOccurrence(occurrence),
        worker,
        priority: attentionPriority(occurrence),
        routeSession: worker?.session ?? occurrence.sourceSession ?? occurrence.targetSession,
      };
    })
    .sort((left, right) =>
      left.priority - right.priority
      || compareNewestFirst(left.occurrence, right.occurrence),
    );
}

export function selectWorkerContext(
  model: DesktopControlModel,
  workerSelector: number | string,
): WorkerContextModel | null {
  const view = selectDesktopControlView(model);
  const worker = typeof workerSelector === 'number'
    ? view.workers.find(item => item.workerId === workerSelector)
    : view.workers.find(item => item.session === workerSelector);
  if (!worker) return null;
  const parentCopilot = worker.parentCopilotSession
    ? view.copilots.find(copilot => copilot.session === worker.parentCopilotSession) ?? null
    : null;
  return { worker, parentCopilot, occurrences: worker.occurrences };
}

export function selectCopilotContext(
  model: DesktopControlModel,
  session: string,
): CopilotContextModel | null {
  const view = selectDesktopControlView(model);
  const copilot = view.copilots.find(item => item.session === session);
  if (!copilot) return null;
  const workers = [...copilot.workers].sort((left, right) =>
    workerAttentionPriority(left) - workerAttentionPriority(right)
    || left.name.localeCompare(right.name),
  );
  return { copilot, workers, occurrences: copilot.occurrences };
}

export function selectSessionHeader(
  model: DesktopControlModel,
  session: string,
): SessionHeaderModel | null {
  const view = selectDesktopControlView(model);
  const worker = view.workers.find(item => item.session === session);
  if (worker) {
    return {
      kind: 'worker',
      session: worker.session,
      name: worker.name,
      lifecycle: worker.lifecycle,
      runtimeState: worker.runtimeState,
      unreadCount: worker.unreadCount,
      activeAttentionCount: worker.activeAttentionCount,
      agent: worker.agent,
      workdir: worker.workdir,
    };
  }
  const copilot = view.copilots.find(item => item.session === session);
  return copilot ? {
    kind: 'copilot',
    session: copilot.session,
    name: copilot.name,
    lifecycle: copilot.lifecycle,
    runtimeState: null,
    unreadCount: copilot.unreadCount,
    activeAttentionCount: copilot.activeAttentionCount,
    agent: copilot.agent,
    workdir: copilot.workdir,
  } : null;
}

/** Temporary Phase 2 adapter. Removed once every v1 BoardView consumer moves. */
export function selectLegacyBoardView(model: DesktopControlModel): BoardView {
  const view = selectDesktopControlView(model);
  const workerTiles = new Map<number, WorkerTileModel>();
  for (const worker of view.workers) workerTiles.set(worker.workerId, toLegacyWorkerTile(worker));
  const copilotTiles = view.copilots.map(copilot => toLegacyCopilotTile(copilot));

  const groups: BoardGroup[] = view.workerGroups.map(group => {
    const tiles = group.workers.map(worker => workerTiles.get(worker.workerId)!);
    return {
      key: group.kind === 'local-tasks' ? 'tasks' : group.key,
      label: group.label,
      kind: group.kind === 'local-tasks' ? 'tasks' : 'repo',
      tiles,
      attentionCount: tiles.filter(tile => tile.runtime === 'needs-input' || tile.runtime === 'error').length,
      unreadCount: tiles.reduce((sum, tile) => sum + tile.unread, 0),
    };
  });
  if (copilotTiles.length > 0) {
    groups.push({
      key: 'copilots',
      label: 'Copilots',
      kind: 'copilots',
      tiles: copilotTiles,
      attentionCount: 0,
      unreadCount: copilotTiles.reduce((sum, tile) => sum + tile.unread, 0),
    });
  }

  const inbox = [...model.occurrencesById.values()]
    .filter((occurrence): occurrence is HydraNotificationV2 & { kind: InboxNotificationModel['kind'] } =>
      occurrence.kind === 'complete'
      || occurrence.kind === 'needs-input'
      || occurrence.kind === 'error',
    )
    .sort(compareNewestFirst)
    .map((occurrence): InboxNotificationModel => ({
      id: occurrence.id,
      kind: occurrence.kind,
      title: occurrence.title,
      body: occurrence.body,
      createdAt: occurrence.createdAt,
      read: occurrence.readAt !== null,
      targetSession: occurrence.targetSession,
      sourceSession: occurrence.sourceSession,
      action: occurrence.action ? { ...occurrence.action } : null,
    }));

  return {
    groups,
    workerCount: view.workers.length,
    copilotCount: view.copilots.length,
    unreadTotal: view.unreadTotal,
    attentionTotal: groups.reduce((sum, group) => sum + group.attentionCount, 0),
    inbox,
  };
}

export function attentionPriority(occurrence: HydraNotificationV2): number {
  switch (occurrence.kind) {
    case 'error': return 0;
    case 'blocked': return 1;
    case 'needs-input': return 2;
    case 'complete': return occurrence.readAt === null ? 3 : 5;
    case 'info': return 6;
  }
}

export function isAttentionOccurrence(occurrence: HydraNotificationV2): boolean {
  if (occurrence.status !== 'active') return false;
  return occurrence.kind === 'error'
    || occurrence.kind === 'blocked'
    || occurrence.kind === 'needs-input'
    || (occurrence.kind === 'complete' && occurrence.readAt === null);
}

function toWorkerControlRow(
  model: DesktopControlModel,
  worker: SessionListWorker,
): WorkerControlRow {
  const lifecycle = deriveLifecycle(worker.status);
  const runtime = model.runtimeByWorkerId.get(worker.number) ?? null;
  const runtimeState = lifecycle === 'stopped' ? 'unknown' : runtime?.state ?? 'unknown';
  const occurrences = [...model.occurrencesById.values()]
    .filter(occurrence => occurrence.workerId === worker.number)
    .sort(compareNewestFirst)
    .map(cloneOccurrence);
  const unreadCount = countUnread(occurrences);
  const activeAttentionCount = occurrences.filter(isAttentionOccurrence).length;
  return {
    kind: 'worker',
    workerId: worker.number,
    session: worker.session,
    name: worker.name,
    type: worker.type,
    repo: worker.repo,
    repoLabel: repoLabel(worker.repo),
    branch: worker.branch,
    agent: worker.agent,
    lifecycle,
    runtime,
    runtimeState,
    runtimeReason: runtime?.reason ?? null,
    unreadCount,
    activeAttentionCount,
    completed: runtimeState !== 'running'
      && occurrences.some(occurrence => occurrence.kind === 'complete' && occurrence.readAt === null),
    changed: worker.type === 'code'
      ? model.gitStatusBySession[worker.session]?.changed ?? null
      : null,
    attached: worker.attached,
    workdir: worker.workdir,
    parentCopilotSession: worker.copilotSessionName,
    occurrences,
    raw: worker,
  };
}

function toCopilotControlRow(
  model: DesktopControlModel,
  copilot: SessionListCopilot,
  workers: readonly WorkerControlRow[],
): CopilotControlRow {
  const managedWorkers = workers.filter(worker => worker.parentCopilotSession === copilot.session);
  const managedWorkerIds = new Set(managedWorkers.map(worker => worker.workerId));
  const occurrences = [...model.occurrencesById.values()]
    .filter(occurrence =>
      occurrence.targetSession === copilot.session
      || managedWorkerIds.has(occurrence.workerId),
    )
    .sort(compareNewestFirst)
    .map(cloneOccurrence);
  return {
    kind: 'copilot',
    session: copilot.session,
    name: copilot.name,
    agent: copilot.agent,
    mode: copilot.mode,
    lifecycle: deriveLifecycle(copilot.status),
    unreadCount: countUnread(occurrences),
    activeAttentionCount: occurrences.filter(isAttentionOccurrence).length,
    workerCount: managedWorkers.length,
    repoCount: new Set(managedWorkers.map(worker => worker.repo).filter(Boolean)).size,
    managedWorkerIds: [...managedWorkerIds].sort((left, right) => left - right),
    workers: managedWorkers,
    occurrences,
    attached: copilot.attached,
    workdir: copilot.workdir,
    raw: copilot,
  };
}

function buildWorkerGroups(workers: readonly WorkerControlRow[]): WorkerControlGroup[] {
  const repositoryGroups = new Map<string, WorkerControlRow[]>();
  const localTasks: WorkerControlRow[] = [];
  for (const worker of workers) {
    if (worker.type === 'task') {
      localTasks.push(worker);
      continue;
    }
    const key = worker.repo ?? UNKNOWN_REPO_LABEL;
    const group = repositoryGroups.get(key) ?? [];
    group.push(worker);
    repositoryGroups.set(key, group);
  }

  const groups: WorkerControlGroup[] = [...repositoryGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repo, group]) => buildWorkerGroup(`repo:${repo}`, repoLabel(repo), 'repository', group));
  if (localTasks.length > 0) {
    groups.push(buildWorkerGroup('tasks', LOCAL_TASKS_LABEL, 'local-tasks', localTasks));
  }
  return groups;
}

function buildWorkerGroup(
  key: string,
  label: string,
  kind: WorkerControlGroup['kind'],
  workers: readonly WorkerControlRow[],
): WorkerControlGroup {
  const sorted = [...workers].sort(byWorkerNumber);
  return {
    key,
    label,
    kind,
    workers: sorted,
    unreadCount: sorted.reduce((sum, worker) => sum + worker.unreadCount, 0),
    activeAttentionCount: sorted.reduce((sum, worker) => sum + worker.activeAttentionCount, 0),
  };
}

function toLegacyWorkerTile(worker: WorkerControlRow): WorkerTileModel {
  return {
    kind: 'worker',
    session: worker.session,
    number: worker.workerId,
    name: worker.name,
    type: worker.type,
    repo: worker.repo,
    branch: worker.branch,
    agent: worker.agent,
    lifecycle: worker.lifecycle,
    runtime: worker.runtimeState,
    runtimeReason: worker.runtimeReason,
    unread: worker.unreadCount,
    completed: worker.completed,
    changed: worker.changed,
    lastEventAt: worker.runtime?.observedAt ?? null,
    attached: worker.attached,
    workdir: worker.workdir,
    copilotSessionName: worker.parentCopilotSession,
    raw: worker.raw,
  };
}

function toLegacyCopilotTile(copilot: CopilotControlRow): CopilotTileModel {
  const completionNotifications = copilot.occurrences
    .filter(occurrence =>
      occurrence.kind === 'complete'
      && occurrence.targetSession === copilot.session,
    )
    .map(toCompletionNotificationModel);
  return {
    kind: 'copilot',
    session: copilot.session,
    name: copilot.name,
    agent: copilot.agent,
    mode: copilot.mode,
    lifecycle: copilot.lifecycle,
    unread: copilot.unreadCount,
    completed: completionNotifications.some(notification => {
      const occurrence = copilot.occurrences.find(item => item.id === notification.id);
      return occurrence?.readAt === null;
    }),
    completionNotifications,
    workerCount: copilot.workerCount,
    repoCount: copilot.repoCount,
    lastEventAt: null,
    attached: copilot.attached,
    workdir: copilot.workdir,
    raw: copilot.raw,
  };
}

function toCompletionNotificationModel(
  occurrence: HydraNotificationV2,
): CompletionNotificationModel {
  return {
    id: occurrence.id,
    title: occurrence.title,
    createdAt: occurrence.createdAt,
    targetSession: occurrence.targetSession ?? '',
    sourceSession: occurrence.sourceSession,
    actionSession: occurrence.action?.session ?? occurrence.sourceSession,
  };
}

function workerAttentionPriority(worker: WorkerControlRow): number {
  return worker.occurrences.reduce(
    (priority, occurrence) => isAttentionOccurrence(occurrence)
      ? Math.min(priority, attentionPriority(occurrence))
      : priority,
    Number.POSITIVE_INFINITY,
  );
}

function countUnread(occurrences: Iterable<HydraNotificationV2>): number {
  let count = 0;
  for (const occurrence of occurrences) {
    if (occurrence.readAt === null) count += 1;
  }
  return count;
}

function deriveLifecycle(status: string): TileLifecycle {
  return status === 'stopped' ? 'stopped' : 'running';
}

function repoLabel(repo: string | null): string {
  if (!repo) return UNKNOWN_REPO_LABEL;
  const trimmed = repo.replace(/[/\\]+$/, '');
  const segment = trimmed.split(/[/\\]/).pop();
  return segment || repo;
}

function compareNewestFirst(left: HydraNotificationV2, right: HydraNotificationV2): number {
  const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return time !== 0 ? time : left.id.localeCompare(right.id);
}

function byWorkerNumber(left: WorkerControlRow, right: WorkerControlRow): number {
  return left.workerId - right.workerId || left.name.localeCompare(right.name);
}

function cloneOccurrence(occurrence: HydraNotificationV2): HydraNotificationV2 {
  return { ...occurrence, action: occurrence.action && { ...occurrence.action } };
}
