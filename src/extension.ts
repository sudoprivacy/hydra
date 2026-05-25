import * as vscode from 'vscode';
import * as path from 'path';
import { CopilotProvider, WorkerProvider, TmuxItem } from './providers/tmuxSessionProvider';
import { attachCreate } from './commands/attachCreate';
import { newTask } from './commands/newTask';
import { removeTask } from './commands/removeTask';
import { autoAttachOnStartup } from './commands/autoAttach';
import {
  attach,
  attachInEditor,
  openWorktree,
  reviewChanges,
  copyPath,
  newPane,
  newWindow,
  openPR
} from './commands/contextMenu';
import { terminalSmartPaste, pasteImageForce, cleanupTempImages } from './commands/pasteImage';
import { createWorktreeFromBranch } from './commands/createWorktreeFromBranch';
import { createCopilot, createCopilotWithAgent, createPlanCopilot } from './commands/createCopilot';
import { ensureHydraGlobalConfig } from './utils/hydraGlobalConfig';
import { installCli, ensurePathInShellProfile } from './core/cliInstaller';
import { detectAvailableAgents, syncAgentCommandsToHydraConfig } from './utils/agentConfig';
import { HYDRA_PREFIX_COPILOT, HYDRA_PREFIX_WORKER, buildHydraTerminalName } from './utils/hydraEditorGroup';
import { lookupWorkerId } from './core/sessionManager';
import { getHydraSessionsFile } from './core/path';
import { HydraSessionKind, hasHydraItemIdentity, listHydraSessionChoices } from './commands/treeItemResolver';

const SESSION_REFRESH_DEBOUNCE_MS = 200;
const RECENT_TREE_SELECTION_MS = 1000;
const TREE_SELECTION_SETTLE_MS = 75;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function activate(context: vscode.ExtensionContext) {
  const copilotProvider = new CopilotProvider();
  copilotProvider.setExtensionUri(context.extensionUri);
  const workerProvider = new WorkerProvider();
  workerProvider.setExtensionUri(context.extensionUri);

  const copilotView = vscode.window.createTreeView('hydraCopilots', { treeDataProvider: copilotProvider });
  const workerView = vscode.window.createTreeView('hydraWorkers', { treeDataProvider: workerProvider });
  let selectedHydraItem: TmuxItem | undefined;
  let selectedHydraItemAt = 0;
  const rememberHydraSelection = (event: vscode.TreeViewSelectionChangeEvent<TmuxItem>) => {
    const selected = event.selection.find((item) => hasHydraItemIdentity(item));
    if (selected) {
      selectedHydraItem = selected;
      selectedHydraItemAt = Date.now();
    }
  };
  const getSelectedHydraItem = () => {
    if (selectedHydraItem && Date.now() - selectedHydraItemAt <= RECENT_TREE_SELECTION_MS) {
      return selectedHydraItem;
    }
    return undefined;
  };

  const getCommandHydraItemFromArgs = (...args: unknown[]) => {
    const queue = [...args];
    for (const candidate of queue) {
      if (Array.isArray(candidate)) {
        queue.push(...candidate);
        continue;
      }
      if (hasHydraItemIdentity(candidate as TmuxItem)) {
        return candidate as TmuxItem;
      }
    }
    return undefined;
  };

  const pickHydraItem = async (kinds: HydraSessionKind[]) => {
    const choices = listHydraSessionChoices(kinds);
    if (choices.length === 0) return undefined;

    const picked = choices.length === 1 ? { choice: choices[0] } : await vscode.window.showQuickPick(
      choices.map(choice => ({
        label: choice.label,
        description: choice.kind,
        detail: choice.worktreePath,
        choice,
      })),
      { placeHolder: 'Select a Hydra session' },
    );
    if (!picked) return undefined;

    return {
      label: picked.choice.label,
      sessionName: picked.choice.sessionName,
      worktreePath: picked.choice.worktreePath,
      contextValue: picked.choice.kind === 'copilot' ? 'copilotItem' : 'workerItem',
    } as unknown as TmuxItem;
  };

  const getCommandHydraItem = async (kinds: HydraSessionKind[], ...args: unknown[]) => {
    const itemFromArgs = getCommandHydraItemFromArgs(...args);
    if (itemFromArgs) {
      return itemFromArgs;
    }

    await delay(TREE_SELECTION_SETTLE_MS);
    const selected = getSelectedHydraItem();
    return hasHydraItemIdentity(selected) ? selected : await pickHydraItem(kinds);
  };

  const runWithHydraItem = async (
    kinds: HydraSessionKind[],
    action: (item: TmuxItem) => Promise<void>,
    ...args: unknown[]
  ) => {
    const item = await getCommandHydraItem(kinds, ...args);
    if (!item) return;
    await action(item);
  };

  context.subscriptions.push(
    copilotView,
    workerView,
    vscode.commands.registerCommand('tmux.attachCreate', attachCreate),
    vscode.commands.registerCommand('hydra.createWorker', newTask),
    vscode.commands.registerCommand('tmux.removeTask', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], removeTask, ...args)),
    vscode.commands.registerCommand('tmux.refresh', () => { copilotProvider.refresh(); workerProvider.refresh(); }),
    vscode.commands.registerCommand('tmux.attach', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], attach, ...args)),
    vscode.commands.registerCommand('tmux.attachInEditor', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], attachInEditor, ...args)),
    vscode.commands.registerCommand('tmux.openWorktree', async (...args: unknown[]) => runWithHydraItem(['worker'], openWorktree, ...args)),
    vscode.commands.registerCommand('tmux.reviewChanges', async (...args: unknown[]) => runWithHydraItem(['worker'], reviewChanges, ...args)),
    vscode.commands.registerCommand('tmux.copyPath', async (...args: unknown[]) => runWithHydraItem(['worker'], copyPath, ...args)),
    vscode.commands.registerCommand('tmux.newPane', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], newPane, ...args)),
    vscode.commands.registerCommand('tmux.newWindow', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], newWindow, ...args)),
    vscode.commands.registerCommand('tmux.terminalPaste', terminalSmartPaste),
    vscode.commands.registerCommand('tmux.pasteImage', pasteImageForce),
    vscode.commands.registerCommand('tmux.createWorktreeFromBranch', (item) => createWorktreeFromBranch(item)),
    vscode.commands.registerCommand('hydra.openPR', openPR),
    vscode.commands.registerCommand('hydra.createCopilot', createCopilot),
    vscode.commands.registerCommand('hydra.startPlanCopilot', createPlanCopilot),
    vscode.commands.registerCommand('hydra.startCopilotClaude', () => createCopilotWithAgent('claude')),
    vscode.commands.registerCommand('hydra.startCopilotCodex', () => createCopilotWithAgent('codex')),
    vscode.commands.registerCommand('hydra.startCopilotGemini', () => createCopilotWithAgent('gemini')),
    vscode.commands.registerCommand('hydra.startCopilotSudoCode', () => createCopilotWithAgent('sudocode')),
    copilotView.onDidChangeSelection(rememberHydraSelection),
    workerView.onDidChangeSelection(rememberHydraSelection),
  );

  ensureHydraGlobalConfig();
  silentInstallCli(context);
  syncAgentCommandsToHydraConfig();
  autoAttachOnStartup();
  detectAndSetAgentContext();

  const refreshAll = () => { copilotProvider.refresh(); workerProvider.refresh(); };
  registerSessionFileRefreshWatcher(context, refreshAll);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hydra.agentCommands')) {
        syncAgentCommandsToHydraConfig();
        detectAndSetAgentContext();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => {
      refreshAll();
    }),
    vscode.window.onDidCloseTerminal(() => {
      refreshAll();
    }),
    vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) refreshAll();
    }),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      revealSidebarItem(terminal, copilotProvider, workerProvider, copilotView, workerView);
    })
  );

  const intervalId = setInterval(() => {
      refreshAll();
  }, 30000);

  context.subscriptions.push({
      dispose: () => clearInterval(intervalId)
  });
}

function registerSessionFileRefreshWatcher(context: vscode.ExtensionContext, refreshAll: () => void): void {
  const sessionsFile = getHydraSessionsFile();
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(sessionsFile), path.basename(sessionsFile)),
  );
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshAll();
    }, SESSION_REFRESH_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(scheduleRefresh),
    watcher.onDidChange(scheduleRefresh),
    watcher.onDidDelete(scheduleRefresh),
    {
      dispose: () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
      },
    },
  );
}

function getShortName(sessionName: string): string {
  const parts = sessionName.split('_');
  return parts.length > 1 ? parts.slice(1).join('_') : sessionName;
}

function revealSidebarItem(
  terminal: vscode.Terminal,
  copilotProvider: CopilotProvider,
  workerProvider: WorkerProvider,
  copilotView: vscode.TreeView<TmuxItem>,
  workerView: vscode.TreeView<TmuxItem>
): void {
  const name = terminal.name;

  if (name.startsWith(HYDRA_PREFIX_COPILOT)) {
    const items = copilotProvider.getRootItemsCached();
    const found = items.find(item => {
      if (!item.sessionName) return false;
      const shortName = getShortName(item.sessionName);
      return name === buildHydraTerminalName(shortName, 'copilot');
    });
    if (found) {
      copilotView.reveal(found, { select: false, focus: false }).then(undefined, () => {});
    }
    return;
  }

  if (name.startsWith(HYDRA_PREFIX_WORKER)) {
    const items = workerProvider.getWorkerItems();
    const found = items.find(item => {
      if (!item.sessionName) return false;
      const shortName = getShortName(item.sessionName);
      const workerId = lookupWorkerId(item.sessionName);
      return name === buildHydraTerminalName(shortName, 'worker', workerId);
    });
    if (found) {
      workerView.reveal(found, { select: false, focus: false }).then(undefined, () => {});
    }
  }
}

async function detectAndSetAgentContext(): Promise<void> {
  try {
    const available = await detectAvailableAgents();
    vscode.commands.executeCommand('setContext', 'hydra.claudeAvailable', available.includes('claude'));
    vscode.commands.executeCommand('setContext', 'hydra.codexAvailable', available.includes('codex'));
    vscode.commands.executeCommand('setContext', 'hydra.geminiAvailable', available.includes('gemini'));
    vscode.commands.executeCommand('setContext', 'hydra.sudocodeAvailable', available.includes('sudocode'));
    vscode.commands.executeCommand('setContext', 'hydra.noAgentsAvailable', available.length === 0);
  } catch {
    // Best-effort — don't block activation
  }
}

function silentInstallCli(context: vscode.ExtensionContext): void {
  try {
    const version = (context.extension.packageJSON as { version: string }).version;
    const result = installCli(context.extensionPath, version);
    if (result.installed) {
      const shellProfileStatus = ensurePathInShellProfile();
      if (shellProfileStatus !== 'skipped_custom_home') {
        vscode.window.showInformationMessage(
          'Hydra CLI installed. PATH configured automatically — restart your shell or open a new terminal to use `hydra`.'
        );
      }
    }
  } catch (err) {
    // CLI install is best-effort — don't block activation
    console.error('Hydra CLI install failed:', err);
  }
}

export function deactivate() {
  cleanupTempImages();
}
