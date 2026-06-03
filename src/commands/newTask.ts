import * as path from 'path';
import * as vscode from 'vscode';
import { SessionManager } from '../core/sessionManager';
import { getRepoRootFromPath } from '../core/git';
import { TmuxBackendCore } from '../core/tmux';
import { validateBranchName, localBranchExists, getRepoRoot } from '../utils/git';
import { pickAgentType } from '../utils/agentConfig';
import { getActiveBackend } from '../utils/multiplexer';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { detectIdentity, getWorkerCreationBlockedMessage } from '../core/sessionIdentity';
import { buildWorkerPrompt, shouldInjectOnWorkerCreate } from '../core/contextPrompt';

function getBaseBranchOverride(): string | undefined {
  const hydraOverride = vscode.workspace.getConfiguration('hydra').get<string>('baseBranch');
  if (hydraOverride?.trim()) {
    return hydraOverride.trim();
  }

  const legacyOverride = vscode.workspace.getConfiguration('tmuxWorktree').get<string>('baseBranch');
  return legacyOverride?.trim() || undefined;
}

async function tryGetWorkspaceGitRoot(workspacePath: string): Promise<string | null> {
  try {
    return await getRepoRootFromPath(workspacePath);
  } catch {
    return null;
  }
}

function defaultNameForFolder(folderPath: string): string {
  return path.basename(folderPath.replace(/[\\/]+$/, '')) || 'task';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send project-level context to a newly created worker.
 */
function sendWorkerContext(backend: ReturnType<typeof getActiveBackend>, sessionName: string, workdir: string): void {
  if (!shouldInjectOnWorkerCreate()) {
    return;
  }

  (async () => {
    try {
      // Wait for the agent to be ready (same delay as copilot onboarding)
      await delay(8000);

      const contextPrompt = buildWorkerPrompt(workdir);
      if (contextPrompt.trim()) {
        await backend.sendMessage(sessionName, contextPrompt);
      }
    } catch {
      // Best-effort — agent may not be ready yet
    }
  })();
}

async function refreshHydraViewsBeforeAttach(): Promise<void> {
  await vscode.commands.executeCommand('tmux.refresh');
  await delay(500);
}

async function promptOptionalTask(): Promise<string | null | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: 'Task prompt (optional)',
    placeHolder: 'Leave empty to start without an initial prompt',
  });
  if (input === undefined) {
    return null;
  }
  return input?.trim() || undefined;
}

async function createCodeWorker(repoRoot: string): Promise<void> {
  const branchInput = await vscode.window.showInputBox({
    prompt: 'Enter branch name (e.g. feat/auth, fix/session-cleanup)',
    placeHolder: 'feat/my-task',
    validateInput: validateBranchName,
  });
  if (!branchInput) {
    return;
  }

  const branchName = branchInput.trim();
  const validationError = validateBranchName(branchName);
  if (validationError) {
    vscode.window.showErrorMessage(validationError);
    return;
  }

  const agentType = await pickAgentType();
  if (!agentType) {
    return;
  }

  const task = await promptOptionalTask();
  if (task === null) {
    return;
  }

  const branchExisted = await localBranchExists(repoRoot, branchName);
  const sessionManager = new SessionManager(new TmuxBackendCore());
  const { workerInfo, postCreatePromise } = await sessionManager.createWorker({
    repoRoot,
    branchName,
    agentType,
    task,
    baseBranchOverride: getBaseBranchOverride(),
  });

  await refreshHydraViewsBeforeAttach();
  const backend = getActiveBackend();
  backend.attachSession(workerInfo.sessionName, workerInfo.workdir, undefined, 'worker');

  // Send project-level context to the worker
  sendWorkerContext(backend, workerInfo.sessionName, workerInfo.workdir);

  void postCreatePromise.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Worker "${workerInfo.sessionName}" started, but agent initialization did not complete cleanly: ${message}`,
    );
  });

  const action = branchExisted ? 'Resumed' : 'Created';
  vscode.window.showInformationMessage(`${action} code worker: ${workerInfo.sessionName}`);
  void vscode.commands.executeCommand('tmux.refresh');
}

async function chooseTaskWorkdir(workspacePath: string, workspaceIsGitRepo: boolean): Promise<{
  workdir?: string;
  managedWorkdir: boolean;
  defaultName: string;
} | undefined> {
  if (!workspaceIsGitRepo) {
    return {
      workdir: workspacePath,
      managedWorkdir: false,
      defaultName: defaultNameForFolder(workspacePath),
    };
  }

  const source = await vscode.window.showQuickPick([
    {
      label: 'Current Workspace Folder',
      description: workspacePath,
      workerSource: 'current' as const,
    },
    {
      label: 'Choose Local Folder',
      description: 'Use an existing or new local folder',
      workerSource: 'choose' as const,
    },
    {
      label: 'Hydra-Managed Temp Folder',
      description: 'Create under ~/.hydra/tasks',
      workerSource: 'temp' as const,
    },
  ], {
    placeHolder: 'Select task worker folder',
  });

  if (!source) {
    return undefined;
  }

  if (source.workerSource === 'temp') {
    return {
      managedWorkdir: true,
      defaultName: '',
    };
  }

  if (source.workerSource === 'choose') {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use Folder',
    });
    const folder = selected?.[0]?.fsPath;
    if (!folder) {
      return undefined;
    }
    return {
      workdir: folder,
      managedWorkdir: false,
      defaultName: defaultNameForFolder(folder),
    };
  }

  return {
    workdir: workspacePath,
    managedWorkdir: false,
    defaultName: defaultNameForFolder(workspacePath),
  };
}

async function createTaskWorker(workspacePath: string, workspaceIsGitRepo: boolean): Promise<void> {
  const workdirChoice = await chooseTaskWorkdir(workspacePath, workspaceIsGitRepo);
  if (!workdirChoice) {
    return;
  }

  const nameInput = await vscode.window.showInputBox({
    prompt: workdirChoice.managedWorkdir ? 'Task worker name' : 'Task worker name (defaults to folder name)',
    value: workdirChoice.defaultName,
    placeHolder: 'market-research',
    validateInput: (value) => value.trim() ? undefined : 'Task worker name is required.',
  });
  if (!nameInput) {
    return;
  }

  const agentType = await pickAgentType();
  if (!agentType) {
    return;
  }

  const task = await promptOptionalTask();
  if (task === null) {
    return;
  }

  const sessionManager = new SessionManager(new TmuxBackendCore());
  const { workerInfo, postCreatePromise } = await sessionManager.createDirectoryWorker({
    workdir: workdirChoice.workdir,
    managedWorkdir: workdirChoice.managedWorkdir,
    name: nameInput.trim(),
    agentType,
    task,
  });

  await refreshHydraViewsBeforeAttach();
  const backend = getActiveBackend();
  backend.attachSession(workerInfo.sessionName, workerInfo.workdir, undefined, 'worker');

  // Send project-level context to the worker
  sendWorkerContext(backend, workerInfo.sessionName, workerInfo.workdir);

  void postCreatePromise.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Worker "${workerInfo.sessionName}" started, but agent initialization did not complete cleanly: ${message}`,
    );
  });

  vscode.window.showInformationMessage(`Created task worker: ${workerInfo.sessionName}`);
  void vscode.commands.executeCommand('tmux.refresh');
}

export async function newTask(): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  let workspacePath: string;
  let repoRoot: string | null;
  try {
    workspacePath = getRepoRoot();
    repoRoot = await tryGetWorkspaceGitRoot(workspacePath);
    const identity = detectIdentity(repoRoot || workspacePath);
    if (identity?.role === 'worker') {
      vscode.window.showErrorMessage(getWorkerCreationBlockedMessage(identity));
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create worker: ${message}`);
    return;
  }

  try {
    if (repoRoot) {
      const workerType = await vscode.window.showQuickPick([
        {
          label: 'Code Worker',
          description: 'Create a git worktree and branch',
          workerType: 'code' as const,
        },
        {
          label: 'Task Worker',
          description: 'Run in a folder without creating a branch',
          workerType: 'task' as const,
        },
      ], {
        placeHolder: 'Select worker type',
      });

      if (!workerType) {
        return;
      }

      if (workerType.workerType === 'code') {
        await createCodeWorker(repoRoot);
      } else {
        await createTaskWorker(workspacePath, true);
      }
    } else {
      await createTaskWorker(workspacePath, false);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create worker: ${message}`);
  }
}
