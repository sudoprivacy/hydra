import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, execPowerShell } from './exec';
import { HYDRA_COPILOT_SESSION_ENV } from './env';
import { getHydraConfigPath, getHydraHome, getTmuxCommand, toCanonicalPath } from './path';
import { shellQuote, pwshQuote } from './shell';
import { MultiplexerBackendCore, MultiplexerSession, SessionStatusInfo, HydraRole } from './types';
import { logger } from './logger';

interface ExecFailure extends Error {
  stderr?: string;
  stdout?: string;
  code?: number | string;
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

// The list of env vars that must NOT leak into the tmux/psmux process. Strip
// these from the child process environment in exec(), not via an `env -u`
// wrapper — Windows cmd.exe/PowerShell have no `env` binary, so the wrapper
// approach fails before psmux even runs.
export function getTmuxSanitizedEnvKeys(): string[] {
  return Array.from(new Set([
    ...TMUX_ENV_KEYS_TO_STRIP,
    ...Object.keys(process.env).filter(isTmuxIntegrationEnvKey),
  ]));
}

export function buildSanitizedTmuxCommand(command: string): string {
  const tmuxCommand = getTmuxCommand();
  return `${tmuxCommand} ${command}`;
}

// Format-spec builders. Use double quotes around tmux `-F` / `-p` arguments,
// not single. cmd.exe on Windows does not strip single quotes, so they would
// be passed through to tmux/psmux verbatim and every emitted line would be
// wrapped in literal '…' — silently breaking listSessions / getSessionInfo /
// getSessionPanePids parsers. See issue #225 §1.
export function buildListSessionsCommand(): string {
  return `${getTmuxCommand()} list-sessions -F "#{session_name}|||#{session_windows}|||#{session_attached}"`;
}

export function buildSessionInfoCommand(sessionName: string): string {
  return `${getTmuxCommand()} display-message -p -t ${shellQuote(sessionName)} "#{session_attached}|||#{session_activity}"`;
}

export function buildSessionPanePidsCommand(sessionName: string): string {
  return `${getTmuxCommand()} list-panes -t ${shellQuote(sessionName)} -F "#{pane_pid}"`;
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

// On Windows the scrub command body is PowerShell, so it MUST be routed
// through powershell.exe — the default `exec()` uses cmd.exe, which can't
// parse `*>$null` / `foreach` / `ForEach-Object` and would silently skip
// the entire env-scrub step. See issue #225 §2.
async function scrubStoredTmuxEnvironment(sessionName?: string): Promise<void> {
  const command = buildStoredTmuxEnvScrubCommand(sessionName);
  const runner = process.platform === 'win32' ? execPowerShell : exec;
  try {
    await runner(command);
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

export function isTmuxDuplicateSessionError(error: unknown): boolean {
  return getExecFailureText(error).toLowerCase().includes('duplicate session');
}

// psmux (the Windows tmux port) exits non-zero with empty stderr when
// `has-session` finds no match, so the keyword-based detectors above can't
// recognize the "missing session" signal there. Silent non-zero exits with no
// diagnostic output are reserved by tmux/psmux for "the command ran, the
// answer is no" — real failures (binary not found, socket errors, permission
// issues) always produce stderr, so they still bubble up as TmuxUnavailableError.
function isSilentExecFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as ExecFailure;
  if (typeof failure.code !== 'number' || failure.code === 0) return false;
  const stderr = (failure.stderr ?? '').trim();
  const stdout = (failure.stdout ?? '').trim();
  return stderr === '' && stdout === '';
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
      logger.debug('tmux.isInstalled', 'Multiplexer command found', {
        binary: process.platform === 'win32' ? 'psmux' : 'tmux',
      });
      return true;
    } catch {
      logger.warn('tmux.isInstalled', 'Multiplexer command not found', {
        binary: process.platform === 'win32' ? 'psmux' : 'tmux',
      });
      return false;
    }
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    try {
      const output = await exec(buildListSessionsCommand());
      const sessions = output.split('\n').filter(l => l.trim()).map(line => {
        const [name, windows, attached] = line.split('|||');
        return {
          name,
          windows: parseInt(windows, 10) || 1,
          attached: attached === '1'
        };
      });
      logger.debug('tmux.listSessions', 'Listed multiplexer sessions', { count: sessions.length });
      return sessions;
    } catch (error) {
      if (isTmuxNoServerError(error)) {
        logger.debug('tmux.listSessions', 'No multiplexer server is running');
        return [];
      }
      logger.error('tmux.listSessions', 'Unable to list multiplexer sessions', { error });
      throw new TmuxUnavailableError(`Unable to access tmux sessions: ${getExecFailureText(error)}`);
    }
  }

  async createSession(sessionName: string, cwd: string): Promise<void> {
    logger.info('tmux.createSession', 'Creating multiplexer session', {
      sessionName,
      cwd,
      tmuxCommand: getTmuxCommand(),
    });
    try {
      await scrubStoredTmuxEnvironment(sessionName);
      await exec(
        buildSanitizedTmuxCommand(`new-session -d -s ${shellQuote(sessionName)} -c ${shellQuote(cwd)}`),
        { unsetEnv: getTmuxSanitizedEnvKeys() },
      );
      logger.info('tmux.createSession', 'Created multiplexer session', { sessionName, cwd });
    } catch (error) {
      if (isTmuxDuplicateSessionError(error)) {
        try {
          if (await this.hasSession(sessionName)) {
            logger.warn(
              'tmux.createSession',
              'Multiplexer session already exists; reusing existing session',
              { sessionName, cwd },
            );
            return;
          }
        } catch (inspectError) {
          logger.warn(
            'tmux.createSession',
            'Duplicate session reported, but existing session could not be verified',
            { sessionName, cwd, inspectError },
          );
        }
      }
      logger.error('tmux.createSession', 'Failed to create multiplexer session', { sessionName, cwd, error });
      throw error;
    }
  }

  async killSession(sessionName: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    logger.info('tmux.killSession', 'Killing multiplexer session', { sessionName });
    try {
      await exec(`${tmuxCommand} kill-session -t ${shellQuote(sessionName)}`);
      logger.info('tmux.killSession', 'Killed multiplexer session', { sessionName });
    } catch (error) {
      logger.error('tmux.killSession', 'Failed to kill multiplexer session', { sessionName, error });
      throw error;
    }
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const tmuxCommand = getTmuxCommand();
    await exec(`${tmuxCommand} rename-session -t ${shellQuote(oldName)} ${shellQuote(newName)}`);
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      const tmuxCommand = getTmuxCommand();
      await exec(`${tmuxCommand} has-session -t ${shellQuote(sessionName)}`, { logFailure: false });
      logger.debug('tmux.hasSession', 'Multiplexer session exists', { sessionName });
      return true;
    } catch (error) {
      if (
        isTmuxNoServerError(error)
        || isTmuxMissingSessionError(error)
        || isSilentExecFailure(error)
      ) {
        logger.debug('tmux.hasSession', 'Multiplexer session does not exist', { sessionName });
        return false;
      }
      logger.error('tmux.hasSession', 'Unable to inspect multiplexer session', { sessionName, error });
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
    logger.debug('tmux.sendKeys', 'Sending keys to multiplexer session', {
      sessionName,
      keyLength: keys.length,
    });
    await exec(`${tmuxCommand} send-keys -t ${shellQuote(sessionName)} ${shellQuote(keys)} Enter`);
  }

  async capturePane(sessionName: string, lines?: number): Promise<string> {
    const tmuxCommand = getTmuxCommand();
    const startArg = lines ? `-S -${lines}` : '';
    const output = await exec(`${tmuxCommand} capture-pane -t ${shellQuote(sessionName)} -p ${startArg}`.trim());
    logger.debug('tmux.capturePane', 'Captured multiplexer pane', {
      sessionName,
      lines,
      outputLength: output.length,
    });
    return output;
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
      const output = await exec(buildSessionInfoCommand(sessionName));
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
      const output = await exec(buildSessionPanePidsCommand(sessionName));
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
