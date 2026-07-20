// One status vocabulary shared by Desktop presentation surfaces. A session's
// status folds its lifecycle
// (running / stopped) and — for workers — its live runtime projection into a
// single glanceable token:
//   live, running, completed, idle, stopped, needs-input, error, or unknown.

import type { SessionControlRow } from './controlState/selectors';

export type SessionStatus =
  | 'live'
  | 'running'
  | 'completed'
  | 'idle'
  | 'stopped'
  | 'needs-input'
  | 'error'
  | 'unknown';

export const STATUS_LABELS: Record<SessionStatus, string> = {
  live: 'Live',
  running: 'Running',
  completed: 'Completed',
  idle: 'Idle',
  stopped: 'Stopped',
  'needs-input': 'Needs input',
  error: 'Error',
  unknown: 'Unknown',
};

/** Collapse a v2 control row into the shared presentation vocabulary. */
export function controlRowStatus(row: SessionControlRow): SessionStatus {
  if (row.lifecycle === 'stopped') {
    return 'stopped';
  }
  if (row.kind === 'copilot') {
    return 'live';
  }
  if (row.runtimeState === 'needs-input') {
    return 'needs-input';
  }
  if (row.runtimeState === 'error') {
    return 'error';
  }
  if (row.completed) {
    return 'completed';
  }
  switch (row.runtimeState) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    default:
      return 'unknown';
  }
}

/** Statuses that should pull the user's eye (accent colour on dots + tabs). */
export function isAttention(status: SessionStatus): boolean {
  return status === 'needs-input' || status === 'error';
}
