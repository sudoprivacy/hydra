import { exec as execCallback, execFile as execFileCallback } from 'child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'util';
import { getIsolatedEnv } from './path';
import { logger } from './logger';

const execPromise = promisify(execCallback);
const execFilePromise = promisify(execFileCallback);

export interface ExecOptions {
  cwd?: string;
  logFailure?: boolean;
}

// VS Code is a GUI app and doesn't inherit shell PATH.
// Add common binary locations (Homebrew, etc.) to PATH.
function getCurrentPath(): string {
  return process.env.PATH || process.env.Path || '';
}

function getEnhancedPath(): string {
  const currentPath = getCurrentPath();
  const additionalPaths = process.platform === 'win32'
    ? [
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
        path.join(os.homedir(), 'AppData', 'Local', 'pnpm'),
        path.join(os.homedir(), 'scoop', 'shims'),
        'C:\\Program Files\\nodejs',
        'C:\\Program Files\\Git\\cmd',
        'C:\\ProgramData\\chocolatey\\bin',
      ]
    : [
        '/Applications/Codex.app/Contents/Resources',
        '/opt/homebrew/bin',      // Apple Silicon Homebrew
        '/usr/local/bin',         // Intel Mac Homebrew / common location
        '/opt/homebrew/sbin',
        '/usr/local/sbin',
      ];

  const pathSet = new Set(currentPath.split(path.delimiter).map(p => (
    process.platform === 'win32' ? p.toLowerCase() : p
  )));
  const newPaths = additionalPaths.filter(p => {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    return !pathSet.has(key);
  });

  return newPaths.length > 0
    ? `${newPaths.join(path.delimiter)}${path.delimiter}${currentPath}`
    : currentPath;
}

function getExecEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...getIsolatedEnv(),
    PATH: getEnhancedPath(),
  };

  if (process.platform === 'win32') {
    delete env.Path;
  }

  return env;
}

export async function exec(command: string, options?: ExecOptions): Promise<string> {
  const startedAt = Date.now();
  const cwd = options?.cwd;
  logger.debug('exec.start', 'Running shell command', { command, cwd });
  try {
    const { stdout } = await execPromise(command, {
      cwd,
      env: getExecEnv(),
    });
    logger.debug('exec.success', 'Shell command completed', {
      command,
      cwd,
      durationMs: Date.now() - startedAt,
      stdoutLength: stdout.length,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (options?.logFailure === false) {
      logger.debug('exec.probeFailure', 'Shell probe command failed', {
        command,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: failure.code,
        stdoutLength: typeof failure.stdout === 'string' ? failure.stdout.length : undefined,
        stderrLength: typeof failure.stderr === 'string' ? failure.stderr.length : undefined,
      });
    } else {
      logger.error('exec.failure', 'Shell command failed', {
        command,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
        error,
      });
    }
    throw error;
  }
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function resolveCommandPath(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;

  try {
    const lookup = process.platform === 'win32'
      ? await execFilePromise('where.exe', [trimmed], { env: getExecEnv() })
      : await execFilePromise('/bin/sh', ['-lc', `command -v ${posixShellQuote(trimmed)}`], { env: getExecEnv() });

    const lines = lookup.stdout.toString().split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (process.platform === 'win32') {
      const pathExts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map(ext => ext.toLowerCase());
      return lines.find(line => pathExts.includes(path.extname(line).toLowerCase())) || lines[0] || null;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}
