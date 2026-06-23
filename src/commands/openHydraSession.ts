import * as vscode from 'vscode';
import {
  CopilotItem,
  InactiveDetailItem,
  InactiveWorktreeItem,
  TmuxItem,
} from '../providers/tmuxSessionProvider';
import { SessionManager } from '../core/sessionManager';
import { TmuxBackendCore } from '../core/tmux';
import { getActiveBackend } from '../utils/multiplexer';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { sendCopilotOnboarding } from './createCopilot';
import { openChangesReview } from './reviewChanges';
import { awaitWorkerPostCreateOrPublishError } from '../core/workerAttentionNotifications';

export async function openHydraSessionByItem(item: TmuxItem): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  const sessionName = item.sessionName || item.label;
  if (await attachExistingSession(sessionName)) {
    return;
  }

  if (item instanceof CopilotItem && item.classification === 'stopped') {
    await resumeCopilot(sessionName);
    return;
  }

  if (item instanceof InactiveWorktreeItem || item instanceof InactiveDetailItem) {
    const worktreePath = item instanceof InactiveWorktreeItem
      ? item.worktree.path
      : item.worktree!.path;
    await resumeWorker(sessionName, worktreePath);
    return;
  }

  throw new Error(`Session '${sessionName}' not found and cannot be created automatically.`);
}

export async function openHydraSessionByName(sessionName: string): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  if (await attachExistingSession(sessionName)) {
    return;
  }

  const sm = new SessionManager(new TmuxBackendCore());
  const [workers, copilots] = await Promise.all([sm.listWorkers(), sm.listCopilots()]);
  if (workers.some(worker => worker.sessionName === sessionName)) {
    await resumeWorker(sessionName);
    return;
  }
  if (copilots.some(copilot => copilot.sessionName === sessionName)) {
    await resumeCopilot(sessionName);
    return;
  }

  throw new Error(`Session '${sessionName}' not found and cannot be created automatically.`);
}

export async function reviewHydraSessionByName(sessionName: string): Promise<void> {
  const sm = new SessionManager(new TmuxBackendCore());
  const worker = (await sm.listWorkers()).find(entry => entry.sessionName === sessionName);
  if (!worker?.workdir) {
    throw new Error(`Session '${sessionName}' does not have a reviewable worker workdir.`);
  }
  await openChangesReview(worker.workdir);
}

async function attachExistingSession(sessionName: string): Promise<boolean> {
  const backend = getActiveBackend();
  if (!await backend.hasSession(sessionName)) {
    return false;
  }
  const workdir = await backend.getSessionWorkdir(sessionName);
  const role = await backend.getSessionRole(sessionName);
  backend.attachSession(sessionName, workdir, undefined, role);
  return true;
}

async function resumeCopilot(sessionName: string): Promise<void> {
  const backend = getActiveBackend();
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
}

async function resumeWorker(sessionName: string, fallbackWorktreePath?: string): Promise<void> {
  const backend = getActiveBackend();
  let workdir = fallbackWorktreePath;
  try {
    const sm = new SessionManager(new TmuxBackendCore());
    const result = await sm.startWorker(sessionName);
    void awaitWorkerPostCreateOrPublishError(
      result.workerInfo,
      result.postCreatePromise,
      { eventSource: 'extension' },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(
        `Worker "${result.workerInfo.sessionName}" resumed, but agent initialization did not complete cleanly: ${message}`,
      );
    });
    workdir = result.workerInfo.workdir || workdir;
  } catch {
    if (!workdir) {
      throw new Error(`Worker "${sessionName}" not found in sessions.json`);
    }
    await backend.createSession(sessionName, workdir);
    await backend.setSessionWorkdir(sessionName, workdir);
    await backend.setSessionRole(sessionName, 'worker');
  }

  backend.attachSession(sessionName, workdir, undefined, 'worker');
  vscode.window.showInformationMessage(`Launched session: ${sessionName}`);
  vscode.commands.executeCommand('tmux.refresh');
}
