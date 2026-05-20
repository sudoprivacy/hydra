import * as vscode from "vscode";
import { getActiveBackend } from "../utils/multiplexer";
import {
  TmuxItem,
  TmuxSessionItem,
  WorktreeItem,
  TmuxDetailItem,
  InactiveDetailItem,
  GitStatusItem,
  CopilotItem,
} from "../providers/tmuxSessionProvider";
import { SessionManager } from "../core/sessionManager";
import { TmuxBackendCore } from "../core/tmux";
import { resolveSessionKind, resolveSessionName } from "./treeItemResolver";

function isMainWorktreeItem(item: TmuxItem): boolean {
  if (item instanceof WorktreeItem) return item.isMainWorktree;
  if (item instanceof TmuxDetailItem && item.worktree) return item.worktree.isMain;
  if (item instanceof InactiveDetailItem && item.worktree) return item.worktree.isMain;
  if (item instanceof GitStatusItem) return false;
  return false;
}

function isOrphanItem(item: TmuxItem): boolean {
  if (item instanceof TmuxSessionItem) return item.session.status.classification === 'orphan';
  if (item instanceof TmuxDetailItem && item.session) return item.session.status.classification === 'orphan';
  if (item instanceof WorktreeItem) return !item.hasGit;
  return false;
}

export async function removeTask(item?: TmuxItem): Promise<void> {
  const sessionName = resolveSessionName(item);
  if (!sessionName) {
    vscode.window.showErrorMessage("No session selected. Select a Hydra session and try again.");
    return;
  }

  const sm = new SessionManager(new TmuxBackendCore());
  const kind = resolveSessionKind(item);

  // ── Copilot: archive + kill via SessionManager ──
  if (kind === 'copilot' || item instanceof CopilotItem) {
    const confirm = await vscode.window.showWarningMessage(
      `Kill copilot session "${sessionName}"?`,
      { modal: true },
      "Kill Session",
    );
    if (confirm !== "Kill Session") return;

    await sm.deleteCopilot(sessionName);
    vscode.window.showInformationMessage(`Killed copilot session: ${sessionName}`);
    vscode.commands.executeCommand("tmux.refresh");
    return;
  }

  // ── Main worktree: stop only (cannot delete primary worktree) ──
  if (item && isMainWorktreeItem(item)) {
    const backend = getActiveBackend();
    if (!await backend.hasSession(sessionName)) {
      vscode.window.showInformationMessage(
        `No active session for primary worktree "${sessionName}". Nothing to remove.`
      );
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Kill tmux session "${sessionName}"?\n(Primary worktree cannot be removed)`,
      { modal: true },
      "Kill Session",
    );
    if (confirm !== "Kill Session") return;

    await sm.stopWorker(sessionName);
    vscode.window.showInformationMessage(`Killed session: ${sessionName}`);
    vscode.commands.executeCommand("tmux.refresh");
    return;
  }

  // ── Orphan: worktree already gone, delete via SessionManager ──
  if (item && isOrphanItem(item)) {
    const confirm = await vscode.window.showWarningMessage(
      `Kill orphan session "${sessionName}"? (Worktree no longer exists)`,
      { modal: true },
      "Kill Session",
    );
    if (confirm !== "Kill Session") return;

    await sm.deleteWorker(sessionName);
    vscode.commands.executeCommand("tmux.refresh");
    return;
  }

  // ── Regular worker: delete session + worktree + branch atomically ──
  const confirm = await vscode.window.showWarningMessage(
    `Delete session "${sessionName}" and its worktree? This cannot be undone.`,
    { modal: true },
    "Delete Session & Worktree",
  );
  if (confirm !== "Delete Session & Worktree") return;

  await sm.deleteWorker(sessionName);
  vscode.window.showInformationMessage(`Removed: ${sessionName}`);
  vscode.commands.executeCommand("tmux.refresh");
}
