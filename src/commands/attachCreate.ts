import * as vscode from 'vscode';
import { getRepoRoot } from '../utils/git';
import { getActiveBackend } from '../utils/multiplexer';
import { TmuxItem } from '../providers/tmuxSessionProvider';
import { createRepoSessionPrefixConfig, isWorkdirInRepo } from '../utils/sessionCompatibility';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { showHydraCommandError } from './logs';
import { openHydraSessionByItem } from './openHydraSession';

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
  await openHydraSessionByItem(item);
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
    void showHydraCommandError('Failed to attach/create', 'command.attachCreate', error);
  }
}
