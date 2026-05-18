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
import { createCopilot, createCopilotWithAgent } from './commands/createCopilot';
import { ensureHydraGlobalConfig } from './utils/hydraGlobalConfig';
import { installCli, ensurePathInShellProfile } from './core/cliInstaller';
import { detectAvailableAgents, syncAgentCommandsToHydraConfig } from './utils/agentConfig';
import { HYDRA_PREFIX_COPILOT, HYDRA_PREFIX_WORKER, buildHydraTerminalName } from './utils/hydraEditorGroup';
import { lookupWorkerId } from './core/sessionManager';
import { getHydraSessionsFile } from './core/path';

const SESSION_REFRESH_DEBOUNCE_MS = 200;

export function activate(context: vscode.ExtensionContext) {
  const copilotProvider = new CopilotProvider();
  copilotProvider.setExtensionUri(context.extensionUri);
  const workerProvider = new WorkerProvider();
  workerProvider.setExtensionUri(context.extensionUri);

  const copilotView = vscode.window.createTreeView('hydraCopilots', { treeDataProvider: copilotProvider });
  const workerView = vscode.window.createTreeView('hydraWorkers', { treeDataProvider: workerProvider });
  context.subscriptions.push(
    copilotView,
    workerView,
    vscode.commands.registerCommand('tmux.attachCreate', attachCreate),
    vscode.commands.registerCommand('hydra.createWorker', newTask),
    vscode.commands.registerCommand('tmux.removeTask', (item) => removeTask(item)),
    vscode.commands.registerCommand('tmux.refresh', () => { copilotProvider.refresh(); workerProvider.refresh(); }),
    vscode.commands.registerCommand('tmux.attach', attach),
    vscode.commands.registerCommand('tmux.attachInEditor', attachInEditor),
    vscode.commands.registerCommand('tmux.openWorktree', openWorktree),
    vscode.commands.registerCommand('tmux.reviewChanges', reviewChanges),
    vscode.commands.registerCommand('tmux.copyPath', copyPath),
    vscode.commands.registerCommand('tmux.newPane', newPane),
    vscode.commands.registerCommand('tmux.newWindow', newWindow),
    vscode.commands.registerCommand('tmux.terminalPaste', terminalSmartPaste),
    vscode.commands.registerCommand('tmux.pasteImage', pasteImageForce),
    vscode.commands.registerCommand('tmux.createWorktreeFromBranch', (item) => createWorktreeFromBranch(item)),
    vscode.commands.registerCommand('hydra.openPR', openPR),
    vscode.commands.registerCommand('hydra.createCopilot', createCopilot),
    vscode.commands.registerCommand('hydra.startCopilotClaude', () => createCopilotWithAgent('claude')),
    vscode.commands.registerCommand('hydra.startCopilotCodex', () => createCopilotWithAgent('codex')),
    vscode.commands.registerCommand('hydra.startCopilotGemini', () => createCopilotWithAgent('gemini')),
    vscode.commands.registerCommand('hydra.startCopilotSudoCode', () => createCopilotWithAgent('sudocode')),
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
      copilotView.reveal(found, { select: true, focus: false }).then(undefined, () => {});
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
      workerView.reveal(found, { select: true, focus: false }).then(undefined, () => {});
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
