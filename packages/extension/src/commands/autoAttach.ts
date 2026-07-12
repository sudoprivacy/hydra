import * as vscode from 'vscode';
import { getActiveBackend } from '../utils/multiplexer';
import { createRepoSessionPrefixConfig, isWorkdirInRepo } from '../utils/sessionCompatibility';

const STARTUP_ATTACH_DELAY_MS = 500;
const ATTACH_STAGGER_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function autoAttachOnStartup(): Promise<void> {
  // Restoring every detached tmux session creates one terminal/client per
  // worker, steals focus repeatedly, and keeps hidden sessions rendering in the
  // background. Make eager restore opt-in; the sidebar remains the lazy attach
  // surface and tmux keeps every session alive regardless.
  const enabled = vscode.workspace.getConfiguration('hydra').get<boolean>('autoAttachOnStartup', false);
  if (!enabled) return;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;

  const backend = getActiveBackend();
  const repoRoot = workspaceFolders[0].uri.fsPath;
  const sessionPrefixConfig = createRepoSessionPrefixConfig(repoRoot);
  const repoPrefix = sessionPrefixConfig.primaryPrefix;

  const sessions = await backend.listSessions();
  if (sessions.length === 0) return;

  const matching: string[] = [];
  for (const session of sessions) {
    if (session.attached) continue;

    const workdir = session.workdir || await backend.getSessionWorkdir(session.name);
    const inRepo = isWorkdirInRepo(workdir, sessionPrefixConfig.canonicalRepoRoot);
    if (inRepo) {
      matching.push(session.name);
      continue;
    }

    if (session.name.startsWith(repoPrefix)) {
      matching.push(session.name);
      continue;
    }
  }

  if (matching.length === 0) return;

  await sleep(STARTUP_ATTACH_DELAY_MS);

  for (const [index, sessionName] of matching.entries()) {
    if (index > 0) {
      await sleep(ATTACH_STAGGER_MS);
    }
    const session = sessions.find(candidate => candidate.name === sessionName);
    const role = session?.role || await backend.getSessionRole(sessionName);
    backend.attachSession(sessionName, undefined, undefined, role);
  }
}
