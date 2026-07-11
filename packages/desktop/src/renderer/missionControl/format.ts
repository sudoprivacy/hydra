// Small presentation helpers for Mission Control tiles. Pure and framework-free
// so the board stays declarative and the strings live in one place.

import type { WorkerRuntimeState } from '@hydra/protocol';

import type { SessionLifecycle } from '../controlState/selectors';

export const RUNTIME_LABELS: Record<WorkerRuntimeState, string> = {
  unknown: 'Unknown',
  running: 'Running',
  idle: 'Idle',
  'needs-input': 'Needs input',
  error: 'Error',
};

/** Human label for a runtime projection. */
export function runtimeLabel(state: WorkerRuntimeState): string {
  return RUNTIME_LABELS[state] ?? state;
}

/** CSS modifier suffix for a runtime projection (`needs-input` → `needs-input`). */
export function runtimeModifier(state: WorkerRuntimeState): string {
  return state;
}

export function lifecycleLabel(lifecycle: SessionLifecycle): string {
  return lifecycle === 'running' ? 'running' : 'stopped';
}

/** The small green completed chip (mirrors the old tree's `complete → completed`). */
export const COMPLETED_CHIP_LABEL = 'Complete';

/**
 * A worker's lifecycle/runtime text token for the row (`running` / `idle` /
 * `stopped` / `needs input` / `error` / `unknown`). A stopped worker has no live
 * runtime, so lifecycle wins; otherwise the runtime state drives it. Mirrors the
 * old tree's `formatWorkerRuntimeStateLabel`.
 */
export function runtimeToken(lifecycle: SessionLifecycle, runtime: WorkerRuntimeState): string {
  if (lifecycle === 'stopped') {
    return 'stopped';
  }
  return runtime === 'needs-input' ? 'needs input' : runtime;
}

/**
 * The copilot's `[N workers · M repos]` summary, with old-tree singular/plural
 * and the repo clause dropped when a copilot manages only task workers. `null`
 * when the copilot manages no workers (nothing to show).
 */
export function copilotSummaryLabel(workerCount: number, repoCount: number): string | null {
  if (workerCount <= 0) {
    return null;
  }
  const workers = `${workerCount} worker${workerCount === 1 ? '' : 's'}`;
  if (repoCount <= 0) return workers;
  const repos = `${repoCount} repo${repoCount === 1 ? '' : 's'}`;
  return `${workers} · ${repos}`;
}

/** Compact changed-file count for a code-worker row, hidden at 0/unknown. */
export function gitChangeLabel(changed: number | null | undefined): string | null {
  return changed && changed > 0 ? String(changed) : null;
}

/**
 * A compact "time ago" for the last-event stamp. Kept coarse — the board is a
 * glanceable cockpit, not a log viewer. `now` is injectable for tests.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return '—';
  }
  const deltaSec = Math.round((now - then) / 1000);
  if (deltaSec < 0) {
    return 'just now';
  }
  if (deltaSec < 10) {
    return 'just now';
  }
  if (deltaSec < 60) {
    return `${deltaSec}s ago`;
  }
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) {
    return `${deltaMin}m ago`;
  }
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) {
    return `${deltaHr}h ago`;
  }
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 7) {
    return `${deltaDay}d ago`;
  }
  return new Date(then).toLocaleDateString();
}
