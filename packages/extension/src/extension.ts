import * as vscode from 'vscode';
import * as fs from 'fs';
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
import { installCli, ensurePathInShellProfile } from '@hydra/core/cliInstaller';
import {
  detectAvailableAgents,
  seedDefaultAgentToHydraConfig,
  syncAgentCommandsToHydraConfig,
  syncDefaultAgentToHydraConfig,
} from './utils/agentConfig';
import { HYDRA_PREFIX_COPILOT, HYDRA_PREFIX_WORKER, buildHydraTerminalName } from './utils/hydraEditorGroup';
import { lookupWorkerId } from '@hydra/core/sessionManager';
import { getHydraSessionsFile } from '@hydra/core/path';
import { NotificationStateService } from '@hydra/core/notificationStateService';
import { HydraSessionKind, hasHydraItemIdentity, listHydraSessionChoices } from './commands/treeItemResolver';
import { configureLoggerFromVSCode, logExtensionActivated, registerHydraLogCommands } from './commands/logs';
import { exec } from './utils/exec';
import { NotificationDecorationProvider } from './providers/notificationDecorationProvider';
import { createNotificationTreeCommands } from './commands/notificationTreeCommands';
import { WorkerNeedsInputMonitor } from '@hydra/core/workerNeedsInputMonitor';
import { WorkerRuntimeStateService } from '@hydra/core/workerRuntimeStateService';

const SESSION_REFRESH_DEBOUNCE_MS = 200;
const SESSION_REFRESH_POLL_INTERVAL_MS = 1000;
const WORKER_GIT_HEAD_REFRESH_POLL_INTERVAL_MS = 1000;
const RECENT_TREE_SELECTION_MS = 1000;
const TREE_SELECTION_SETTLE_MS = 75;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function activate(context: vscode.ExtensionContext) {
  configureLoggerFromVSCode();
  const hydraOutputChannel = vscode.window.createOutputChannel('Hydra');
  registerHydraLogCommands(context, hydraOutputChannel);
  logExtensionActivated(context);

  const notificationState = new NotificationStateService();
  notificationState.initialize();
  const workerRuntimeState = new WorkerRuntimeStateService();
  workerRuntimeState.initialize();
  const notificationDecorations = new NotificationDecorationProvider(notificationState);
  const needsInputMonitor = new WorkerNeedsInputMonitor();
  needsInputMonitor.initialize();

  const copilotProvider = new CopilotProvider(notificationState, workerRuntimeState);
  copilotProvider.setExtensionUri(context.extensionUri);
  const workerProvider = new WorkerProvider(notificationState, workerRuntimeState);
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

  let syncWorkerGitHeadWatchers: () => void = () => {};
  const refreshTreeViews = () => { copilotProvider.refresh(); workerProvider.refresh(); };
  const refreshAll = () => {
    refreshTreeViews();
    syncWorkerGitHeadWatchers();
  };
  const notificationCommands = createNotificationTreeCommands(notificationState);

  context.subscriptions.push(
    copilotView,
    workerView,
    vscode.commands.registerCommand('tmux.attachCreate', attachCreate),
    vscode.commands.registerCommand('hydra.createWorker', newTask),
    vscode.commands.registerCommand('tmux.removeTask', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], removeTask, ...args)),
    vscode.commands.registerCommand('tmux.refresh', refreshAll),
    vscode.commands.registerCommand('tmux.attach', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], attach, ...args)),
    vscode.commands.registerCommand('tmux.attachInEditor', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], attachInEditor, ...args)),
    vscode.commands.registerCommand('tmux.openWorktree', async (...args: unknown[]) => runWithHydraItem(['worker'], openWorktree, ...args)),
    vscode.commands.registerCommand('tmux.reviewChanges', async (...args: unknown[]) => runWithHydraItem(['worker'], reviewChanges, ...args)),
    vscode.commands.registerCommand('tmux.copyPath', async (...args: unknown[]) => runWithHydraItem(['worker'], copyPath, ...args)),
    vscode.commands.registerCommand('tmux.newPane', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], newPane, ...args)),
    vscode.commands.registerCommand('tmux.newWindow', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], newWindow, ...args)),
    vscode.commands.registerCommand('hydra.openSessionNotification', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], notificationCommands.openSessionNotification, ...args)),
    vscode.commands.registerCommand('hydra.markSessionNotificationsRead', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], notificationCommands.markSessionNotificationsRead, ...args)),
    vscode.commands.registerCommand('hydra.clearSessionNotifications', async (...args: unknown[]) => runWithHydraItem(['worker', 'copilot'], notificationCommands.clearSessionNotifications, ...args)),
    vscode.commands.registerCommand('tmux.terminalPaste', terminalSmartPaste),
    vscode.commands.registerCommand('tmux.pasteImage', pasteImageForce),
    vscode.commands.registerCommand('tmux.createWorktreeFromBranch', (item) => createWorktreeFromBranch(item)),
    vscode.commands.registerCommand('hydra.openPR', openPR),
    vscode.commands.registerCommand('hydra.createCopilot', createCopilot),
    vscode.commands.registerCommand('hydra.startPlanCopilot', createPlanCopilot),
    vscode.commands.registerCommand('hydra.startCopilotClaude', () => createCopilotWithAgent('claude')),
    vscode.commands.registerCommand('hydra.startCopilotCodex', () => createCopilotWithAgent('codex')),
    vscode.commands.registerCommand('hydra.startCopilotGemini', () => createCopilotWithAgent('gemini')),
    vscode.commands.registerCommand('hydra.startCopilotAntigravity', () => createCopilotWithAgent('antigravity')),
    vscode.commands.registerCommand('hydra.startCopilotSudoCode', () => createCopilotWithAgent('sudocode')),
    copilotView.onDidChangeSelection(rememberHydraSelection),
    workerView.onDidChangeSelection(rememberHydraSelection),
    vscode.window.registerFileDecorationProvider(notificationDecorations),
  );

  ensureHydraGlobalConfig();
  context.subscriptions.push(
    notificationState,
    workerRuntimeState,
    needsInputMonitor,
    notificationState.onDidChange(() => {
      refreshTreeViews();
      notificationDecorations.refresh();
    }),
    workerRuntimeState.onDidChange(() => {
      refreshTreeViews();
    }),
  );
  silentInstallCli(context);
  seedDefaultAgentToHydraConfig();
  syncAgentCommandsToHydraConfig();
  autoAttachOnStartup();
  detectAndSetAgentContext();

  syncWorkerGitHeadWatchers = registerWorkerGitHeadRefreshWatcher(context, refreshTreeViews);
  syncWorkerGitHeadWatchers();
  registerSessionFileRefreshWatcher(context, refreshAll);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hydra.agentCommands')) {
        syncAgentCommandsToHydraConfig();
        detectAndSetAgentContext();
      }
      if (e.affectsConfiguration('hydra.defaultAgent')) {
        syncDefaultAgentToHydraConfig();
      }
      if (e.affectsConfiguration('hydra.logging')) {
        configureLoggerFromVSCode();
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
      refreshAll();
      delay(750)
        .then(() => revealSidebarItem(terminal, copilotProvider, workerProvider, copilotView, workerView))
        .then(undefined, () => {});
    })
  );

  const intervalId = setInterval(() => {
      refreshAll();
  }, 60000);

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
  let lastSessionsFileSignature = getFileSignature(sessionsFile);

  const scheduleRefresh = () => {
    lastSessionsFileSignature = getFileSignature(sessionsFile);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshAll();
    }, SESSION_REFRESH_DEBOUNCE_MS);
  };

  fs.watchFile(sessionsFile, { interval: SESSION_REFRESH_POLL_INTERVAL_MS }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
      return;
    }
    const currentSignature = getFileStatSignature(current);
    if (currentSignature === lastSessionsFileSignature) {
      return;
    }
    scheduleRefresh();
  });

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
        fs.unwatchFile(sessionsFile);
      },
    },
  );
}

interface SessionWorkerEntry {
  source?: string;
  workdir?: string;
  repoRoot?: string | null;
}

interface SessionStateFile {
  workers?: Record<string, SessionWorkerEntry>;
}

interface GitHeadWatch {
  headPath: string;
  listener: (current: fs.Stats, previous: fs.Stats) => void;
}

function registerWorkerGitHeadRefreshWatcher(
  context: vscode.ExtensionContext,
  refreshTreeViews: () => void,
): () => void {
  const watchers = new Map<string, GitHeadWatch>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let syncGeneration = 0;

  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshTreeViews();
    }, SESSION_REFRESH_DEBOUNCE_MS);
  };

  const stopWatching = (workdir: string) => {
    const watch = watchers.get(workdir);
    if (!watch) return;
    fs.unwatchFile(watch.headPath, watch.listener);
    watchers.delete(workdir);
  };

  const startWatching = (workdir: string, headPath: string) => {
    const listener = (current: fs.Stats, previous: fs.Stats) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      scheduleRefresh();
    };

    fs.watchFile(headPath, { interval: WORKER_GIT_HEAD_REFRESH_POLL_INTERVAL_MS }, listener);
    watchers.set(workdir, { headPath, listener });
  };

  const sync = () => {
    const generation = ++syncGeneration;
    void (async () => {
      const workdirs = readRepoWorkerWorkdirs();
      const entries = await Promise.all(workdirs.map(async (workdir) => ({
        workdir,
        headPath: await resolveGitHeadPath(workdir),
      })));

      if (generation !== syncGeneration) return;

      const desired = new Map<string, string>();
      for (const entry of entries) {
        if (entry.headPath) {
          desired.set(entry.workdir, entry.headPath);
        }
      }

      for (const [workdir, watch] of watchers) {
        if (desired.get(workdir) !== watch.headPath) {
          stopWatching(workdir);
        }
      }

      for (const [workdir, headPath] of desired) {
        if (!watchers.has(workdir)) {
          startWatching(workdir, headPath);
        }
      }
    })();
  };

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      for (const workdir of [...watchers.keys()]) {
        stopWatching(workdir);
      }
    },
  });

  return sync;
}

function readRepoWorkerWorkdirs(): string[] {
  try {
    const sessionsFile = getHydraSessionsFile();
    if (!fs.existsSync(sessionsFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as SessionStateFile;
    const workdirs = Object.values(parsed.workers || {})
      .filter(worker => worker.source !== 'directory')
      .map(worker => worker.workdir)
      .filter((workdir): workdir is string => Boolean(workdir && fs.existsSync(workdir)));
    return [...new Set(workdirs.map(workdir => path.resolve(workdir)))];
  } catch {
    return [];
  }
}

async function resolveGitHeadPath(workdir: string): Promise<string | null> {
  try {
    const gitDir = await exec('git rev-parse --git-dir', { cwd: workdir });
    if (!gitDir) return null;
    const resolvedGitDir = path.isAbsolute(gitDir)
      ? gitDir
      : path.resolve(workdir, gitDir);
    const headPath = path.join(resolvedGitDir, 'HEAD');
    return fs.existsSync(headPath) ? headPath : null;
  } catch {
    return null;
  }
}

function getFileSignature(filePath: string): string {
  try {
    return getFileStatSignature(fs.statSync(filePath));
  } catch {
    return 'missing';
  }
}

function getFileStatSignature(stat: fs.Stats): string {
  if (stat.mtimeMs === 0 && stat.size === 0) {
    return 'missing';
  }
  return `${stat.mtimeMs}:${stat.size}`;
}

function getShortName(sessionName: string): string {
  const parts = sessionName.split('_');
  return parts.length > 1 ? parts.slice(1).join('_') : sessionName;
}

async function revealSidebarItem(
  terminal: vscode.Terminal,
  copilotProvider: CopilotProvider,
  workerProvider: WorkerProvider,
  copilotView: vscode.TreeView<TmuxItem>,
  workerView: vscode.TreeView<TmuxItem>
): Promise<void> {
  const name = terminal.name;

  if (name.startsWith(HYDRA_PREFIX_COPILOT)) {
    const items = await copilotProvider.refreshAndGetCopilotItems();
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
    const items = await workerProvider.refreshAndGetWorkerItems();
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
    vscode.commands.executeCommand('setContext', 'hydra.antigravityAvailable', available.includes('antigravity'));
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
