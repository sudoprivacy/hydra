import * as vscode from 'vscode';
import { createBackendFromConfig } from './backendFactory';
import { MultiplexerBackendCore, HydraRole } from '../core/types';

// ─── Re-export shared types from core ─────────────────────
export { MultiplexerType, HydraRole, MultiplexerSession, SessionStatusInfo } from '../core/types';

// ─── Backend Interface (extends core with vscode-specific attachSession) ──

export interface MultiplexerBackend extends MultiplexerBackendCore {
  attachSession(
    sessionName: string,
    cwd?: string,
    location?: vscode.TerminalLocation | vscode.TerminalEditorLocationOptions,
    role?: HydraRole
  ): vscode.Terminal;
}

// ─── Backend Registry & Factory ───────────────────────────

let activeBackend: MultiplexerBackend | undefined;

export function getActiveBackend(): MultiplexerBackend {
  if (!activeBackend) {
    activeBackend = createBackendFromConfig();
  }
  return activeBackend;
}

export function refreshBackendFromConfig(): void {
  activeBackend = createBackendFromConfig();
}

/**
 * Read the user's multiplexer preference from VS Code settings.
 * Currently only 'tmux' is supported.
 */
export function getConfiguredMultiplexerType(): 'tmux' {
  return 'tmux';
}
