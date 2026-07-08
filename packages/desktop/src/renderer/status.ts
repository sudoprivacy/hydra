// One status vocabulary shared by the sidebar dots and the tab dots so a session
// looks the same wherever it appears. A session's status folds its lifecycle
// (running / stopped) and — for workers — its live runtime projection into a
// single glanceable token:
//   running 🟢 · idle ⚪ · stopped ⚫ · needs-input 🟡 · error 🔴 · unknown grey.

import type { TileModel } from './missionControl/boardModel';

export type SessionStatus =
  | 'running'
  | 'idle'
  | 'stopped'
  | 'needs-input'
  | 'error'
  | 'unknown';

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  stopped: 'Stopped',
  'needs-input': 'Needs input',
  error: 'Error',
  unknown: 'Unknown',
};

/** Collapse a tile's lifecycle + runtime into the shared status vocabulary. */
export function tileStatus(tile: TileModel): SessionStatus {
  if (tile.lifecycle === 'stopped') {
    return 'stopped';
  }
  // Copilots have no runtime projection — a live copilot is simply "running".
  if (tile.kind === 'copilot') {
    return 'running';
  }
  switch (tile.runtime) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'needs-input':
      return 'needs-input';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

/** Statuses that should pull the user's eye (accent colour on dots + tabs). */
export function isAttention(status: SessionStatus): boolean {
  return status === 'needs-input' || status === 'error';
}
