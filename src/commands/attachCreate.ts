import * as vscode from 'vscode';
import { getRepoRoot } from '../utils/git';
import { getActiveBackend } from '../utils/multiplexer';
import { InactiveWorktreeItem, InactiveDetailItem, CopilotItem, TmuxItem } from '../providers/tmuxSessionProvider';
import { createRepoSessionPrefixConfig, isWorkdirInRepo } from '../utils/sessionCompatibility';
import { SessionManager } from '../core/sessionManager';
import { TmuxBackendCore } from '../core/tmux';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { sendCopilotOnboarding } from './createCopilot';

async function findSessionsForWorkspace(repoRoot: string): Promise<string[]> {
  const backend = getActiveBackend();
  const sessions = await backend.listSessions();
  const matchingSessions: string[] = [];
  const sessionPrefixConfig = createRepoSessionPrefixConfig(repoRoot);
  const repoPrefix = sessionPrefixConfig.primaryPrefix;

  for (const session of sessions) {
    const workdir = session.workdir || await backend.getSessionWorkdir(session.name);
    const inRepo = isWorkdirInRepo(workdir, sessionPrefixConfig.canonicalRepoRoot);
    if (inRepo) {
      matchingSessions.push(session.name);
      continue;
    }

    if (session.name.startsWith(repoPrefix)) {
      matchingSessions.push(session.name);
      continue;
    }
  }

  return matchingSessions;
}

async function handleTreeViewItem(item: TmuxItem): Promise<void> {
    const backend = getActiveBackend();
    const sessionName = item.sessionName || item.label;

    const sessions = await backend.listSessions();
    const exists = sessions.some(s => s.name === sessionName);

    if (exists) {
        const workdir = await backend.getSessionWorkdir(sessionName);
        const role = await backend.getSessionRole(sessionName);
        backend.attachSession(sessionName, workdir, undefined, role);
        return;
    }

    // Stopped copilot: resume via SessionManager
    if (item instanceof CopilotItem && item.classification === 'stopped') {
        const sm = new SessionManager(new TmuxBackendCore());
        const result = await sm.startCopilot(sessionName);
        result.postCreatePromise.catch(() => {});
        const { workdir, copilotMode } = result.copilotInfo;
        if (!result.resumed) {
            sendCopilotOnboarding(backend, sessionName, copilotMode ?? 'normal');
        }
        backend.attachSession(sessionName, workdir, undefined, 'copilot');
        vscode.window.showInformationMessage(`Resumed copilot: ${sessionName}`);
        vscode.commands.executeCommand('tmux.refresh');
        return;
    }

    // Inactive worktree: resume the agent via SessionManager
    if (item instanceof InactiveWorktreeItem || item instanceof InactiveDetailItem) {
        const worktreePath = item instanceof InactiveWorktreeItem
            ? item.worktree.path
            : item.worktree!.path;

        try {
            const sm = new SessionManager(new TmuxBackendCore());
            const result = await sm.startWorker(sessionName);
            result.postCreatePromise.catch(() => {});
        } catch {
            // Fallback for worktrees without sessions.json entries (legacy)
            await backend.createSession(sessionName, worktreePath);
            await backend.setSessionWorkdir(sessionName, worktreePath);
            await backend.setSessionRole(sessionName, 'worker');
        }

        backend.attachSession(sessionName, worktreePath, undefined, 'worker');
        vscode.window.showInformationMessage(`Launched session: ${sessionName}`);
        vscode.commands.executeCommand('tmux.refresh');
        return;
    }

    vscode.window.showErrorMessage(`Session '${sessionName}' not found and cannot be created automatically.`);
}

async function handleCommandExecution(): Promise<void> {
    const backend = getActiveBackend();
    const repoRoot = getRepoRoot();
    const matchingSessions = await findSessionsForWorkspace(repoRoot);

    if (matchingSessions.length > 0) {
        for (const session of matchingSessions) {
            const workdir = await backend.getSessionWorkdir(session);
            const role = await backend.getSessionRole(session);
            backend.attachSession(session, workdir, undefined, role);
        }
        vscode.window.showInformationMessage(`Attached to ${matchingSessions.length} session(s)`);
    } else {
        vscode.window.showInformationMessage(
            `No existing ${backend.displayName} session found for this workspace. Ask your copilot to create a worker.`
        );
    }
}

export async function attachCreate(item?: TmuxItem | string): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  try {
    if (item instanceof TmuxItem) {
        await handleTreeViewItem(item);
    } else {
        await handleCommandExecution();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to attach/create: ${message}`);
  }
}
