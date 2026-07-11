import type {
  CopilotControlRow,
  DesktopControlView,
  WorkerControlGroup,
  WorkerControlRow,
} from '../controlState/selectors';

export interface FilteredSidebarView {
  readonly query: string;
  readonly copilots: readonly CopilotControlRow[];
  readonly workerGroups: readonly WorkerControlGroup[];
  readonly noMatches: boolean;
}

export function filterSidebarView(
  view: DesktopControlView,
  rawQuery: string,
): FilteredSidebarView {
  const query = rawQuery.trim().toLocaleLowerCase();
  const copilots = view.copilots.filter(copilot => matchesCopilot(copilot, query));
  const workerGroups = view.workerGroups
    .map(group => ({
      ...group,
      workers: group.workers.filter(worker => matchesWorker(worker, query)),
    }))
    .filter(group => group.workers.length > 0);
  return {
    query,
    copilots,
    workerGroups,
    noMatches: Boolean(query) && copilots.length === 0 && workerGroups.length === 0,
  };
}

function matchesCopilot(copilot: CopilotControlRow, query: string): boolean {
  return !query || includesQuery([
    copilot.name,
    copilot.session,
    copilot.agent,
    copilot.workdir,
  ], query);
}

function matchesWorker(worker: WorkerControlRow, query: string): boolean {
  return !query || includesQuery([
    worker.name,
    worker.session,
    worker.agent,
    worker.repo,
    worker.branch,
    worker.workdir,
    worker.parentCopilotSession,
  ], query);
}

function includesQuery(values: readonly (string | null)[], query: string): boolean {
  return values.some(value => value?.toLocaleLowerCase().includes(query));
}
