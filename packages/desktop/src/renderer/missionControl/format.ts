// Small presentation helpers for Mission Control tiles. Pure and framework-free
// so the board stays declarative and the strings live in one place.

import type { WorkerRuntimeState } from '@hydra/protocol';

import type { TileLifecycle } from './boardModel';

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

export function lifecycleLabel(lifecycle: TileLifecycle): string {
  return lifecycle === 'running' ? 'running' : 'stopped';
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
