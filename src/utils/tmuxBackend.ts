import * as vscode from 'vscode';
import { exec, execPowerShell } from './exec';
import { TmuxBackendCore, buildStoredTmuxEnvScrubCommand } from '../core/tmux';
import { buildTmuxMouseScrollbackCommand } from '../core/tmuxAttach';
import { getIsolatedEnv, getTmuxCommand } from '../core/path';
import { MultiplexerBackend, HydraRole } from './multiplexer';
import { getHydraEditorLocation, buildHydraTerminalName, getHydraTerminalIcon, getHydraTerminalColor, HYDRA_PREFIX_WORKER } from './hydraEditorGroup';
import { lookupWorkerId } from '../core/sessionManager';

function getShortName(sessionName: string): string {
  const parts = sessionName.split('_');
  if (parts.length > 1) {
    return parts.slice(1).join('_');
  }
  return sessionName;
}

function findTerminalBySession(sessionName: string): vscode.Terminal | undefined {
  const shortName = getShortName(sessionName);
  const workerId = lookupWorkerId(sessionName);
  const candidateNames = new Set([
    buildHydraTerminalName(shortName, 'copilot'),
    buildHydraTerminalName(shortName, 'worker', workerId),
    HYDRA_PREFIX_WORKER, // legacy: bare prefix without ID
    shortName, // legacy: no prefix
  ]);
  return vscode.window.terminals.find(t => candidateNames.has(t.name));
}

export class TmuxBackend extends TmuxBackendCore implements MultiplexerBackend {
  attachSession(
    sessionName: string,
    cwd?: string,
    location?: vscode.TerminalLocation | vscode.TerminalEditorLocationOptions,
    role?: HydraRole
  ): vscode.Terminal {
    const resolvedLocation = location ?? getHydraEditorLocation(role);
    const shortName = getShortName(sessionName);
    const workerId = role === 'worker' ? lookupWorkerId(sessionName) : undefined;
    const terminalName = buildHydraTerminalName(shortName, role, workerId);

    const existing = findTerminalBySession(sessionName);

    if (existing) {
      const tmuxCommand = getTmuxCommand();
      // The Windows mouse-on body is PowerShell (`*>$null`), so it must be
      // routed through powershell.exe — exec()'s cmd.exe can't parse it and
      // would silently no-op. See issue #225 §2.
      const mouseRunner = process.platform === 'win32' ? execPowerShell : exec;
      void mouseRunner(buildTmuxMouseScrollbackCommand(sessionName)).catch(() => {});
      void exec(`${tmuxCommand} set-window-option -t "${sessionName}":. window-size latest`).catch(() => {});
      const options = existing.creationOptions as vscode.TerminalOptions;
      // For editor locations, reuse if both are editor-area targets
      const existingIsEditor = options?.location !== vscode.TerminalLocation.Panel;
      const requestedIsEditor = resolvedLocation !== vscode.TerminalLocation.Panel;
      // Also verify the terminal has the Hydra icon and the expected name.
      // Legacy terminals (created before icons were added, or restored by VS Code
      // persistence) may lack the icon or use an outdated name format.
      const hasCorrectIcon = Boolean(options?.iconPath);
      const hasCorrectName = existing.name === terminalName;
      if (options && existingIsEditor === requestedIsEditor && hasCorrectIcon && hasCorrectName) {
        existing.show();
        return existing;
      }
      existing.dispose();
    }

    const tmuxCommand = getTmuxCommand();
    let shellPath: string;
    let shellArgs: string[];

    if (process.platform === 'win32') {
      // Windows: PowerShell with simplified attach (VS Code handles terminal sizing)
      const escapedName = sessionName.replace(/'/g, "''");
      const attachCommand = [
        buildStoredTmuxEnvScrubCommand(sessionName),
        `${tmuxCommand} set-option -gq set-clipboard on *>$null`,
        `${tmuxCommand} set-option -agq terminal-features ',xterm-256color:clipboard' *>$null`,
        `${tmuxCommand} set-option -agq terminal-overrides ',*:clipboard' *>$null`,
        buildTmuxMouseScrollbackCommand(sessionName),
        `${tmuxCommand} set-window-option -gwq allow-passthrough on *>$null`,
        `${tmuxCommand} set-window-option -t '${escapedName}':. window-size latest *>$null`,
        `${tmuxCommand} attach -t '${escapedName}'`,
      ].join('\n');
      shellPath = 'powershell.exe';
      shellArgs = ['-NoProfile', '-Command', attachCommand];
    } else {
      // Unix: /bin/sh with stty sizing for proper initial terminal dimensions
      const escapedName = sessionName.replace(/'/g, "'\\''");
      const attachCommand = [
        buildStoredTmuxEnvScrubCommand(sessionName),
        `${tmuxCommand} set-option -gq set-clipboard on >/dev/null 2>&1 || true`,
        `${tmuxCommand} set-option -agq terminal-features ',xterm-256color:clipboard' >/dev/null 2>&1 || true`,
        `${tmuxCommand} set-option -agq terminal-overrides ',*:clipboard' >/dev/null 2>&1 || true`,
        buildTmuxMouseScrollbackCommand(sessionName),
        `${tmuxCommand} set-window-option -gwq allow-passthrough on >/dev/null 2>&1 || true`,
        "rows=''; cols=''",
        "for _ in 1 2 3 4 5; do",
        "size=$(stty size 2>/dev/null || true)",
        "candidate_rows=${size%% *}",
        "candidate_cols=${size##* }",
        "if [ -n \"$candidate_rows\" ] && [ -n \"$candidate_cols\" ] && [ \"$candidate_rows\" -gt 0 ] && [ \"$candidate_cols\" -gt 0 ]; then rows=\"$candidate_rows\"; cols=\"$candidate_cols\"; fi",
        "if [ -n \"$rows\" ] && [ \"$rows\" -ge 30 ] && [ \"$cols\" -ge 100 ]; then break; fi",
        "sleep 0.04",
        "done",
        "if [ -n \"$rows\" ] && [ \"$rows\" -ge 1 ] && [ \"$cols\" -ge 1 ]; then " + tmuxCommand + " set-option -t '" + escapedName + "' default-size \"${cols}x${rows}\" >/dev/null 2>&1 || true; fi",
        "if [ -n \"$rows\" ] && [ \"$rows\" -ge 1 ] && [ \"$cols\" -ge 1 ]; then " + tmuxCommand + " resize-window -t '" + escapedName + "':. -x \"$cols\" -y \"$rows\" >/dev/null 2>&1 || true; fi",
        `${tmuxCommand} set-window-option -t '${escapedName}':. window-size latest >/dev/null 2>&1 || true`,
        "sleep 0.08",
        `exec ${tmuxCommand} attach -t '${escapedName}'`
      ].join('\n');
      shellPath = '/bin/sh';
      shellArgs = ['-c', attachCommand];
    }

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      shellPath,
      shellArgs,
      cwd: cwd,
      env: {
        'TERM': 'xterm-256color',
        'TERM_PROGRAM': null,
        'TERM_PROGRAM_VERSION': null,
        'VSCODE_SHELL_INTEGRATION': null,
        'VSCODE_INJECTION': null,
        ...getIsolatedEnv(),
      },
      location: resolvedLocation,
      iconPath: getHydraTerminalIcon(),
      color: getHydraTerminalColor(role)
    });
    terminal.show();
    return terminal;
  }
}
