// One status vocabulary shared by the sidebar dots and the tab dots so a session
// looks the same wherever it appears. A session's status folds its lifecycle
// (running / stopped) and — for workers — its live runtime projection into a
// single glanceable token:
//   running, idle, stopped, needs-input, error, or unknown.

import type { SessionControlRow } from './controlState/selectors';

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

/** Collapse a v2 control row into the shared presentation vocabulary. */
export function controlRowStatus(row: SessionControlRow): SessionStatus {
  if (row.lifecycle === 'stopped') {
    return 'stopped';
  }
  if (row.kind === 'copilot') {
    return 'running';
  }
  switch (row.runtimeState) {
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
