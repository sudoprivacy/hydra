import * as vscode from 'vscode';
import { MultiplexerBackend } from '../utils/multiplexer';
import { logger } from '../core/logger';

const INSTALL_PSMUX_ACTION = 'Install psmux';
const COPY_COMMAND_ACTION = 'Copy command';

const PSMUX_INSTALL_COMMAND = 'winget install psmux --accept-source-agreements --accept-package-agreements';
const TMUX_INSTALL_COMMAND = 'brew install tmux';

function showPsmuxInstallTerminal(): void {
  const terminal = vscode.window.createTerminal({ name: 'Hydra Setup: psmux' });
  terminal.show();
  terminal.sendText(PSMUX_INSTALL_COMMAND);

  void vscode.window.showInformationMessage(
    'psmux installation started in the terminal. When it finishes, restart VS Code or run the Hydra command again.',
  );
}

async function promptForPsmuxInstall(): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    'Hydra needs psmux on Windows to keep copilot and worker sessions persistent.',
    INSTALL_PSMUX_ACTION,
    COPY_COMMAND_ACTION,
  );

  if (choice === INSTALL_PSMUX_ACTION) {
    logger.info('command.ensureBackendInstalled', 'Starting psmux installation terminal');
    showPsmuxInstallTerminal();
    return;
  }

  if (choice === COPY_COMMAND_ACTION) {
    await vscode.env.clipboard.writeText(PSMUX_INSTALL_COMMAND);
    logger.info('command.ensureBackendInstalled', 'Copied psmux install command');
    void vscode.window.showInformationMessage('Copied psmux install command to clipboard.');
  }
}

async function promptForTmuxInstall(backend: MultiplexerBackend): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    `${backend.displayName} is required but not installed. Run: ${TMUX_INSTALL_COMMAND}`,
    COPY_COMMAND_ACTION,
  );

  if (choice === COPY_COMMAND_ACTION) {
    await vscode.env.clipboard.writeText(TMUX_INSTALL_COMMAND);
    logger.info('command.ensureBackendInstalled', 'Copied tmux install command', { backend: backend.displayName });
    void vscode.window.showInformationMessage('Copied tmux install command to clipboard.');
  }
}

export async function ensureBackendInstalled(backend: MultiplexerBackend): Promise<boolean> {
  if (await backend.isInstalled()) {
    logger.debug('command.ensureBackendInstalled', 'Multiplexer backend is installed', { backend: backend.displayName });
    return true;
  }

  logger.warn('command.ensureBackendInstalled', 'Multiplexer backend is missing', {
    backend: backend.displayName,
    platform: process.platform,
  });
  if (process.platform === 'win32') {
    await promptForPsmuxInstall();
    return false;
  }

  await promptForTmuxInstall(backend);
  return false;
}
