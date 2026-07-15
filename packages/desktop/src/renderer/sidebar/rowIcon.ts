import type { CopilotControlRow, WorkerControlRow } from '../controlState/selectors';

export type TreeRowIconName = 'git-branch' | null;
type TreeRowIconSource =
  | Pick<WorkerControlRow, 'kind' | 'type'>
  | Pick<CopilotControlRow, 'kind'>;

export function treeRowIconName(row: TreeRowIconSource): TreeRowIconName {
  return row.kind === 'worker' && row.type === 'task' ? null : 'git-branch';
}
