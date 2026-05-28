import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from './exec';
import { HYDRA_COPILOT_SESSION_ENV } from './env';
import { getHydraConfigPath, getHydraHome, getTmuxCommand, toCanonicalPath } from './path';
import { shellQuote, pwshQuote } from './shell';
import { MultiplexerBackendCore, MultiplexerSession, SessionStatusInfo, HydraRole } from './types';

interface ExecFailure extends Error {
  stderr?: string;
  stdout?: string;
}

const TMUX_ENV_KEYS_TO_STRIP = [
  'ELECTRON_RUN_AS_NODE',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VSCODE_INJECTION',
  'VSCODE_SHELL_INTEGRATION',
  HYDRA_COPILOT_SESSION_ENV,
];

function isTmuxIntegrationEnvKey(key: string): boolean {
  return key.startsWith('VSCODE_') || TMUX_ENV_KEYS_TO_STRIP.includes(key);
}

function getTmuxSanitizedEnvKeys(): string[] {
  return Array.from(new Set([
    ...TMUX_ENV_KEYS_TO_STRIP,
    ...Object.keys(process.env).filter(isTmuxIntegrationEnvKey),
  ]));
}

export function buildSanitizedTmuxCommand(command: string): string {
  const envKeys = getTmuxSanitizedEnvKeys();
  const tmuxCommand = getTmuxCommand();
  if (envKeys.length === 0) {
    return `${tmuxCommand} ${command}`;
  }
  const unsetArgs = envKeys.map((key) => `-u ${shellQuote(key)}`).join(' ');
  return `env ${unsetArgs} ${tmuxCommand} ${command}`;
}

function buildStoredTmuxEnvScrubCommandPowerShell(sessionName?: string): string {
  const tmuxCommand = getTmuxCommand();
  const sessionTarget = sessionName ? ` -t ${pwshQuote(sessionName)}` : '';
  const varsToSet = [
    `${tmuxCommand} set-environment -g HYDRA_HOME ${pwshQuote(getHydraHome())} *>$null`,
    `${tmuxCommand} set-environment -g HYDRA_CONFIG_PATH ${pwshQuote(getHydraConfigPath())} *>$null`,
  ];

  if (process.env.HYDRA_TMUX_SOCKET) {
    varsToSet.push(
      `${tmuxCommand} set-environment -g HYDRA_TMUX_SOCKET ${pwshQuote(process.env.HYDRA_TMUX_SOCKET)} *>$null`,
    );
  }

  return [
    ...varsToSet,
    `foreach ($name in @('ELECTRON_RUN_AS_NODE', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_INJECTION', 'VSCODE_SHELL_INTEGRATION', '${HYDRA_COPILOT_SESSION_ENV}')) {`,
    `  ${tmuxCommand} set-environment -gu $name *>$null`,
    `  ${tmuxCommand} set-environment${sessionTarget} -u $name *>$null`,
    '}',
    `(${tmuxCommand} show-environment -g 2>$null) | ForEach-Object {`,
    `  $name = $_.Split('=')[0]`,
    `  if ($name -like 'VSCODE_*') {`,
    `    ${tmuxCommand} set-environment -gu $name *>$null`,
    `    ${tmuxCommand} set-environment${sessionTarget} -u $name *>$null`,
    '  }',
    '}',
  ].join('\n');
}

export function buildStoredTmuxEnvScrubCommand(sessionName?: string): string {
  if (process.platform === 'win32') {
    return buildStoredTmuxEnvScrubCommandPowerShell(sessionName);
  }

  const tmuxCommand = getTmuxCommand();
  const sessionTarget = sessionName ? ` -t ${shellQuote(sessionName)}` : '';
  const varsToSet = [
    `${tmuxCommand} set-environment -g HYDRA_HOME ${shellQuote(getHydraHome())} >/dev/null 2>&1 || true`,
    `${tmuxCommand} set-environment -g HYDRA_CONFIG_PATH ${shellQuote(getHydraConfigPath())} >/dev/null 2>&1 || true`,
  ];

  if (process.env.HYDRA_TMUX_SOCKET) {
    varsToSet.push(
      `${tmuxCommand} set-environment -g HYDRA_TMUX_SOCKET ${shellQuote(process.env.HYDRA_TMUX_SOCKET)} >/dev/null 2>&1 || true`,
    );
  }

  return [
    ...varsToSet,
    `for name in ELECTRON_RUN_AS_NODE TERM_PROGRAM TERM_PROGRAM_VERSION VSCODE_INJECTION VSCODE_SHELL_INTEGRATION ${HYDRA_COPILOT_SESSION_ENV}; do`,
    `${tmuxCommand} set-environment -gu "$name" >/dev/null 2>&1 || true`,
    `${tmuxCommand} set-environment${sessionTarget} -u "$name" >/dev/null 2>&1 || true`,
    'done',
    `${tmuxCommand} show-environment -g 2>/dev/null | while IFS= read -r line; do`,
    'name=${line%%=*}',
    'case "$name" in',
    'VSCODE_*)',
    `${tmuxCommand} set-environment -gu "$name" >/dev/null 2>&1 || true`,
    `${tmuxCommand} set-environment${sessionTarget} -u "$name" >/dev/null 2>&1 || true`,
    ';;',
    'esac',
    'done'
  ].join('\n');
}

async function scrubStoredTmuxEnvironment(sessionName?: string): Promise<void> {
  try {
    await exec(buildStoredTmuxEnvScrubCommand(sessionName));
  } catch {
    // No tmux server yet is fine; createSession will start one with a sanitized env.
  }
}

function getExecFailureText(error: unknown): string {
  if (error instanceof Error) {
    const failure = error as ExecFailure;
    return [failure.message, failure.stderr, failure.stdout]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n')
      .trim();
  }
  return String(error);
}

function isTmuxNoServerError(error: unknown): boolean {
  const text = getExecFailureText(error).toLowerCase();
  return text.includes('no server running')
    || (text.includes('error connecting to') && text.includes('no such file or directory'));
}

function isTmuxMissingSessionError(error: unknown): boolean {
  const text = getExecFailureText(error).toLowerCase();
  return text.includes(`can't find session`)
    || text.includes('no such session')
    || text.includes('session not found');
}

export class TmuxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TmuxUnavailableError';
  }
}

export class TmuxBackendCore implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'tmux';
  readonly installHint = process.platform === 'win32'
    ? 'Install: `winget install psmux`'
    : 'Install: `brew install tmux`';

  async isInstalled(): Promise<boolean> {
    try {
      const cmd = process.platform === 'win32' ? 'where psmux' : 'which tmux';
      await exec(cmd);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} list-sessions -F '#{session_name}|||#{session_windows}|||#{session_attached}'`);
      return output.split('\n').filter(l => l.trim()).map(line => {
        const [name, windows, attached] = line.split('|||');
        return {
          name,
          windows: parseInt(windows, 10) || 1,
          attached: attached === '1'
        };
      });
    } catch (error) {
      if (isTmuxNoServerError(error)) {
        return [];
      }
      throw new TmuxUnavailableError(`Unable to access tmux sessions: ${getExecFailureText(error)}`);
    }
  }

  async createSession(sessionName: string, cwd: string): Promise<void> {
    await scrubStoredTmuxEnvironment(sessionName);
    await exec(buildSanitizedTmuxCommand(`new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(cwd)}`));
  }

  async killSession(sessionName: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} kill-session -t ${shellQuote(sessionName)}`);
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} rename-session -t ${shellQuote(oldName)} ${shellQuote(newName)}`);
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      const tmuxCommand = getTmuxCommand();
      await exec(`${tmuxCommand} has-session -t ${shellQuote(sessionName)}`);
      return true;
    } catch (error) {
      if (isTmuxNoServerError(error) || isTmuxMissingSessionError(error)) {
        return false;
      }
      throw new TmuxUnavailableError(`Unable to inspect tmux session "${sessionName}": ${getExecFailureText(error)}`);
    }
  }

  async getSessionWorkdir(sessionName: string): Promise<string | undefined> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} show-options -t ${shellQuote(sessionName)} @workdir`);
      const parts = output.split(' ');
      if (parts.length >= 2) {
        const rawPath = parts.slice(1).join(' ').trim();
        return toCanonicalPath(rawPath) || rawPath;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} set-option -t ${shellQuote(sessionName)} @workdir ${shellQuote(workdir)}`);
  }

  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} show-options -t ${shellQuote(sessionName)} @hydra-role`);
      const parts = output.split(' ');
      if (parts.length >= 2) {
        const value = parts.slice(1).join(' ').trim() as HydraRole;
        if (value === 'copilot' || value === 'worker') return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} set-option -t ${shellQuote(sessionName)} @hydra-role ${shellQuote(role)}`);
  }

  async getSessionAgent(sessionName: string): Promise<string | undefined> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} show-options -t ${shellQuote(sessionName)} @hydra-agent`);
      const parts = output.split(' ');
      if (parts.length >= 2) {
        const value = parts.slice(1).join(' ').trim();
        return value || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async setSessionAgent(sessionName: string, agent: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} set-option -t ${shellQuote(sessionName)} @hydra-agent ${shellQuote(agent)}`);
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} send-keys -t ${shellQuote(sessionName)} ${shellQuote(keys)} Enter`);
  }

  async capturePane(sessionName: string, lines?: number): Promise<string> {
    const tmuxCommand = getTmuxCommand();
    const startArg = lines ? `-S -${lines}` : '';
    return exec(`${tmuxCommand} capture-pane -t ${shellQuote(sessionName)} -p ${startArg}`.trim());
  }

  async sendMessage(sessionName: string, message: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    // Write message to a temp file and load it into a tmux buffer.
    // This avoids shell-quoting issues and ARG_MAX limits that cause
    // send-keys -l to silently drop the trailing Enter on long or
    // special-character-heavy messages.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bufferName = `hydra-send-${suffix}`;
    const tmpFile = path.join(os.tmpdir(), `hydra-msg-${suffix}`);
    try {
      fs.writeFileSync(tmpFile, message);
      await exec(`${tmuxCommand} load-buffer -b ${bufferName} ${shellQuote(tmpFile)}`);
      await exec(`${tmuxCommand} paste-buffer -b ${bufferName} -t ${shellQuote(sessionName)} -d`);
      await new Promise(resolve => setTimeout(resolve, 100));
      // Send Enter separately to submit
      await exec(`${tmuxCommand} send-keys -t ${shellQuote(sessionName)} Enter`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    }
  }

  async getSessionInfo(sessionName: string): Promise<SessionStatusInfo> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} display-message -p -t ${shellQuote(sessionName)} '#{session_attached}|||#{session_activity}'`);
      const [attachedStr, activityStr] = output.split('|||');
      return {
        attached: attachedStr === '1',
        lastActive: parseInt(activityStr, 10) || 0,
      };
    } catch {
      return { attached: false, lastActive: 0 };
    }
  }

  async getSessionPaneCount(sessionName: string): Promise<number> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} list-panes -t ${shellQuote(sessionName)}`);
      return output.split('\n').filter(l => l.trim()).length || 1;
    } catch {
      return 1;
    }
  }

  async getSessionPanePids(sessionName: string): Promise<string[]> {
    try {
      const tmuxCommand = getTmuxCommand();
      const output = await exec(`${tmuxCommand} list-panes -t ${shellQuote(sessionName)} -F '#{pane_pid}'`);
      return output.split('\n').filter(l => l.trim());
    } catch {
      return [];
    }
  }

  async splitPane(sessionName: string, cwd?: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    const cwdArg = cwd ? `-c ${shellQuote(cwd)}` : '';
    await exec(`${tmuxCommand} split-window -v -t ${shellQuote(sessionName)} ${cwdArg}`);
  }

  async newWindow(sessionName: string, cwd?: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    const cwdArg = cwd ? `-c ${shellQuote(cwd)}` : '';
    await exec(`${tmuxCommand} new-window -t ${shellQuote(sessionName)} ${cwdArg}`);
  }

  buildSessionName(repoName: string, slug: string): string {
    return `${this.sanitizeSessionName(repoName)}_${this.sanitizeSessionName(slug)}`;
  }

  sanitizeSessionName(name: string): string {
    return name.replace(/[/\\\s.:]/g, '-');
  }
}
