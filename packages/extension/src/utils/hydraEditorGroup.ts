import * as vscode from 'vscode';
import * as path from 'path';
import { HydraRole } from './multiplexer';

export const HYDRA_PREFIX_COPILOT = 'Copilot:';
export const HYDRA_PREFIX_WORKER = 'Worker:';
export const HYDRA_PREFIX_REVIEW = 'Review:';

/**
 * Scan tabGroups for a tab whose label starts with the given prefix.
 * Returns the viewColumn of the first match, or undefined.
 */
function findGroupByPrefix(prefix: string): vscode.ViewColumn | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (typeof tab.label === 'string' && tab.label.startsWith(prefix)) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

/**
 * Get the location options for a Hydra terminal.
 * When a role is specified, discovers the editor group containing only that role's tabs.
 * Falls back to ViewColumn.Beside when no matching group is found (creates a new group).
 */
export function getHydraEditorLocation(role?: HydraRole): vscode.TerminalEditorLocationOptions {
  let existing: vscode.ViewColumn | undefined;
  if (role === 'copilot') {
    existing = findGroupByPrefix(HYDRA_PREFIX_COPILOT);
  } else if (role === 'worker') {
    existing = findGroupByPrefix(HYDRA_PREFIX_WORKER);
  } else {
    // No role: search for either prefix (backward compat)
    existing = findGroupByPrefix(HYDRA_PREFIX_COPILOT) ?? findGroupByPrefix(HYDRA_PREFIX_WORKER);
  }
  return { viewColumn: existing ?? vscode.ViewColumn.Beside, preserveFocus: false };
}

/**
 * Find the viewColumn of the editor group hosting Hydra review-changes diff tabs,
 * identified by tab labels starting with HYDRA_PREFIX_REVIEW.
 */
export function findReviewGroupColumn(): vscode.ViewColumn | undefined {
  return findGroupByPrefix(HYDRA_PREFIX_REVIEW);
}

const FOCUS_EDITOR_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

/**
 * Focus an editor group by 1-indexed viewColumn. No-op for out-of-range columns.
 */
export async function focusEditorGroup(column: vscode.ViewColumn): Promise<void> {
  if (typeof column !== 'number' || column < 1 || column > FOCUS_EDITOR_GROUP_COMMANDS.length) {
    return;
  }
  await vscode.commands.executeCommand(FOCUS_EDITOR_GROUP_COMMANDS[column - 1]);
}

const MAX_COPILOT_NAME_LENGTH = 20;

/**
 * Build a terminal name based on role.
 * - Worker: just the prefix — VS Code appends the cwdFolder automatically.
 * - Copilot: prefix + agent name (truncated), since copilots have no worktree cwd.
 */
export function buildHydraTerminalName(shortName: string, role?: HydraRole, workerId?: number): string {
  if (role === 'copilot') {
    let agentName = shortName.replace(/^hydra-copilot-/, '');
    if (agentName.length > MAX_COPILOT_NAME_LENGTH) {
      agentName = agentName.slice(0, MAX_COPILOT_NAME_LENGTH - 1) + '\u2026';
    }
    return `${HYDRA_PREFIX_COPILOT} ${agentName}`;
  }
  if (role === 'worker') {
    return workerId != null ? `${HYDRA_PREFIX_WORKER} #${workerId}` : HYDRA_PREFIX_WORKER;
  }
  return shortName;
}

/**
 * Get the terminal icon (resources/tmux.svg) for a Hydra terminal.
 */
export function getHydraTerminalIcon(): vscode.Uri {
  // __dirname at runtime is `out/utils/`, so go up two levels to reach the extension root
  return vscode.Uri.file(path.join(__dirname, '..', '..', 'resources', 'tmux.svg'));
}

/**
 * Get the terminal tab color based on role.
 * Blue for copilot, green for worker.
 */
export function getHydraTerminalColor(role?: HydraRole): vscode.ThemeColor | undefined {
  if (role === 'copilot') return new vscode.ThemeColor('terminal.ansiBlue');
  if (role === 'worker') return new vscode.ThemeColor('terminal.ansiGreen');
  return undefined;
}
