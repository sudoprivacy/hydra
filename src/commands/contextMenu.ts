import * as vscode from 'vscode';
import {
  TmuxItem,
  TmuxSessionItem,
  GitStatusItem,
  CopilotItem,
} from '../providers/tmuxSessionProvider';
import { getActiveBackend, HydraRole } from '../utils/multiplexer';
import { getHydraEditorLocation } from '../utils/hydraEditorGroup';
import { exec } from '../utils/exec';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { openChangesReview } from './reviewChanges';
import { resolveSessionName, resolveWorktreePath } from './treeItemResolver';

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

function getNestedStringField(value: unknown, objectField: string, stringField: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[objectField];
  if (!candidate || typeof candidate !== 'object') return undefined;
  const nested = (candidate as Record<string, unknown>)[stringField];
  return typeof nested === 'string' && nested ? nested : undefined;
}

function getRoleFromItem(item?: TmuxItem): HydraRole | undefined {
  const structuralRole = getNestedStringField(item, 'session', 'hydraRole');
  if (structuralRole === 'worker' || structuralRole === 'copilot') return structuralRole;
  if (getStringField(item, 'contextValue') === 'copilotItem') return 'copilot';

  if (item instanceof CopilotItem) return 'copilot';
  if (item instanceof TmuxSessionItem) return item.session.hydraRole;
  return undefined;
}

async function ensureSessionExists(sessionName: string, worktreePath?: string): Promise<void> {
  const backend = getActiveBackend();
  if (await backend.hasSession(sessionName)) {
    return;
  }

  if (!worktreePath) {
    throw new Error('Worktree path not found (cannot create session).');
  }

  await backend.createSession(sessionName, worktreePath);
  await backend.setSessionWorkdir(sessionName, worktreePath);
}

export async function attach(item?: TmuxItem): Promise<void> {
  const sessionName = resolveSessionName(item);
  if (!sessionName) {
    vscode.window.showErrorMessage('No session selected');
    return;
  }
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  try {
    const worktreePath = await resolveWorktreePath(item);
    await ensureSessionExists(sessionName, worktreePath);

    const cwd = worktreePath || await backend.getSessionWorkdir(sessionName);
    await backend.splitPane(sessionName, cwd);
    vscode.window.showInformationMessage(`Opened terminal pane in ${sessionName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function attachInEditor(item?: TmuxItem): Promise<void> {
  const sessionName = resolveSessionName(item);
  if (!sessionName) {
    vscode.window.showErrorMessage('No session selected');
    return;
  }
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  try {
    const worktreePath = await resolveWorktreePath(item);
    await ensureSessionExists(sessionName, worktreePath);

    const workdir = worktreePath || await backend.getSessionWorkdir(sessionName);
    const role = getRoleFromItem(item);
    backend.attachSession(sessionName, workdir, getHydraEditorLocation(role), role);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to attach: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function openWorktree(item?: TmuxItem): Promise<void> {
  const worktreePath = await resolveWorktreePath(item);
  if (!worktreePath) {
    vscode.window.showErrorMessage('Worktree path not found');
    return;
  }
  const worktreeUri = vscode.Uri.file(worktreePath);
  await vscode.commands.executeCommand('vscode.openFolder', worktreeUri, true);
}

export async function reviewChanges(item?: TmuxItem): Promise<void> {
  const worktreePath = await resolveWorktreePath(item);
  if (!worktreePath) {
    vscode.window.showErrorMessage('Worktree path not found');
    return;
  }

  try {
    await openChangesReview(worktreePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to review changes: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function copyPath(item?: TmuxItem): Promise<void> {
  const worktreePath = await resolveWorktreePath(item);
  if (!worktreePath) {
    vscode.window.showErrorMessage('Worktree path not found');
    return;
  }
  await vscode.env.clipboard.writeText(worktreePath);
  vscode.window.showInformationMessage(`Copied: ${worktreePath}`);
}

export async function newPane(item?: TmuxItem): Promise<void> {
  const sessionName = resolveSessionName(item);
  if (!sessionName) {
    vscode.window.showErrorMessage('No session selected');
    return;
  }
  const backend = getActiveBackend();
  try {
    if (!await ensureBackendInstalled(backend)) {
      return;
    }

    const cwd = await resolveWorktreePath(item);
    await ensureSessionExists(sessionName, cwd);
    await backend.splitPane(sessionName, cwd);
    vscode.window.showInformationMessage(`New pane created in ${sessionName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create pane: ${err}`);
  }
}

export async function newWindow(item?: TmuxItem): Promise<void> {
  const sessionName = resolveSessionName(item);
  if (!sessionName) {
    vscode.window.showErrorMessage('No session selected');
    return;
  }
  const backend = getActiveBackend();
  try {
    if (!await ensureBackendInstalled(backend)) {
      return;
    }

    const cwd = await resolveWorktreePath(item);
    await ensureSessionExists(sessionName, cwd);
    await backend.newWindow(sessionName, cwd);
    vscode.window.showInformationMessage(`New window created in ${sessionName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create window: ${err}`);
  }
}

export async function openPR(item: TmuxItem): Promise<void> {
  if (!(item instanceof GitStatusItem) || !item.prNumber || !item.worktreePath) {
    return;
  }
  try {
    const url = (await exec(
      `gh pr view ${item.prNumber} --json url -q .url`,
      { cwd: item.worktreePath }
    )).trim();
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to open PR: ${err instanceof Error ? err.message : String(err)}`);
  }
}
