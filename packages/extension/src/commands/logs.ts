import * as vscode from 'vscode';
import {
  formatLogEntryForOutput,
  getHostSummary,
  getHydraLogFilePath,
  getHydraLogsDirectory,
  isLogLevel,
  logger,
  type LogContext,
  type LogLevel,
} from '@hydra/core/logger';
import { getHydraConfigPath, getHydraHome, getTmuxCommand } from '@hydra/core/path';
import { getHydraGlobalDefaultAgent } from '@hydra/core/hydraGlobalConfig';

export const HYDRA_SHOW_LOGS_COMMAND = 'hydra.showLogs';
export const HYDRA_OPEN_LOGS_FOLDER_COMMAND = 'hydra.openLogsFolder';
export const HYDRA_COPY_DIAGNOSTIC_INFO_COMMAND = 'hydra.copyDiagnosticInfo';

const SHOW_LOGS_ACTION = 'Show Logs';
const OPEN_LOGS_FOLDER_ACTION = 'Open Logs Folder';
const COPY_DETAILS_ACTION = 'Copy Details';

export function configureLoggerFromVSCode(): void {
  const hydraConfig = vscode.workspace.getConfiguration('hydra');
  const rawLevel = hydraConfig.get<string>('logging.level', 'info');
  const level = rawLevel && isLogLevel(rawLevel) ? rawLevel : 'info';
  const maxFileSizeMB = hydraConfig.get<number>('logging.maxFileSizeMB', 5);
  const maxFiles = hydraConfig.get<number>('logging.maxFiles', 5);

  logger.configure({
    level,
    maxFileSizeBytes: Math.max(1, maxFileSizeMB) * 1024 * 1024,
    maxFiles: Math.max(1, maxFiles),
  });
}

export function registerHydraLogCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    outputChannel,
    {
      dispose: logger.addSink((entry) => {
        if (shouldShowInOutput(entry.level)) {
          outputChannel.appendLine(formatLogEntryForOutput(entry));
        }
      }),
    },
    vscode.commands.registerCommand(HYDRA_SHOW_LOGS_COMMAND, () => {
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand(HYDRA_OPEN_LOGS_FOLDER_COMMAND, async () => {
      logger.ensureLogsDir();
      await vscode.env.openExternal(vscode.Uri.file(getHydraLogsDirectory()));
    }),
    vscode.commands.registerCommand(HYDRA_COPY_DIAGNOSTIC_INFO_COMMAND, async () => {
      await vscode.env.clipboard.writeText(buildDiagnosticInfo(context));
      void vscode.window.showInformationMessage('Hydra diagnostic info copied.');
    }),
  );
}

export async function showHydraCommandError(
  title: string,
  scope: string,
  error: unknown,
  context?: LogContext,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(scope, title, { ...context, error });
  const choice = await vscode.window.showErrorMessage(
    `${title}: ${message}`,
    SHOW_LOGS_ACTION,
    OPEN_LOGS_FOLDER_ACTION,
    COPY_DETAILS_ACTION,
  );

  if (choice === SHOW_LOGS_ACTION) {
    await vscode.commands.executeCommand(HYDRA_SHOW_LOGS_COMMAND);
  } else if (choice === OPEN_LOGS_FOLDER_ACTION) {
    await vscode.commands.executeCommand(HYDRA_OPEN_LOGS_FOLDER_COMMAND);
  } else if (choice === COPY_DETAILS_ACTION) {
    await vscode.env.clipboard.writeText([
      title,
      `Message: ${message}`,
      `Log file: ${getHydraLogFilePath()}`,
      '',
      buildDiagnosticInfo(),
    ].join('\n'));
    void vscode.window.showInformationMessage('Hydra error details copied.');
  }
}

export function logExtensionActivated(context: vscode.ExtensionContext): void {
  logger.info('extension.activate', 'Hydra extension activated', {
    version: getExtensionVersion(context),
    hydraHome: getHydraHome(),
    hydraConfigPath: getHydraConfigPath(),
    hydraLogFile: getHydraLogFilePath(),
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    ...getHostSummary(),
  });
}

function shouldShowInOutput(level: LogLevel): boolean {
  return level === 'info' || level === 'warn' || level === 'error';
}

function buildDiagnosticInfo(context?: vscode.ExtensionContext): string {
  let defaultAgent = 'unknown';
  try {
    defaultAgent = getHydraGlobalDefaultAgent().agent;
  } catch {
    // Config may not have been initialized yet.
  }

  return [
    'Hydra diagnostics',
    `Version: ${context ? getExtensionVersion(context) : 'unknown'}`,
    `Platform: ${process.platform}`,
    `Arch: ${process.arch}`,
    `Node: ${process.version}`,
    `Hydra home: ${getHydraHome()}`,
    `Hydra config: ${getHydraConfigPath()}`,
    `Hydra log: ${getHydraLogFilePath()}`,
    `Multiplexer command: ${getTmuxCommand()}`,
    `Default agent: ${defaultAgent}`,
  ].join('\n');
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
}
