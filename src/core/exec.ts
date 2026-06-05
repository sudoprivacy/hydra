import {
  exec as execCallback,
  execFile as execFileCallback,
  execSync,
} from 'child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'util';
import iconv from 'iconv-lite';
import { getIsolatedEnv } from './path';
import { logger } from './logger';

const execPromise = promisify(execCallback);
const execFilePromise = promisify(execFileCallback);

const IS_WINDOWS = process.platform === 'win32';

// Cached iconv-lite codec name (e.g. "cp936", "cp932", "cp437") for the
// active Windows console code page. Set on first use and reused thereafter.
let windowsConsoleCodecCache: string | null = null;

function detectWindowsConsoleCodec(): string {
  // (a) Respect OEMCP if Windows or the user provided one explicitly.
  const oemcp = process.env.OEMCP?.trim();
  if (oemcp && /^\d+$/.test(oemcp)) {
    const codec = `cp${oemcp}`;
    if (iconv.encodingExists(codec)) return codec;
  }

  // (b) Probe `chcp` once and parse "Active code page: NNN" (any locale —
  //     fall back to the first run of digits anywhere in the output).
  try {
    const out = execSync('chcp', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }).toString();
    const match = out.match(/(\d{3,5})/);
    if (match) {
      const codec = `cp${match[1]}`;
      if (iconv.encodingExists(codec)) return codec;
    }
  } catch {
    // chcp unavailable — fall through to the default.
  }

  // (c) Sensible fallback for OEM-locale Windows.
  return iconv.encodingExists('cp437') ? 'cp437' : 'utf8';
}

function getWindowsConsoleCodec(): string {
  if (windowsConsoleCodecCache !== null) return windowsConsoleCodecCache;
  windowsConsoleCodecCache = detectWindowsConsoleCodec();
  logger.debug('exec.codec', 'Detected Windows console codec', {
    codec: windowsConsoleCodecCache,
  });
  return windowsConsoleCodecCache;
}

function decodeChildOutput(value: unknown, codec: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return iconv.decode(value, codec);
  return String(value);
}

export interface ExecOptions {
  cwd?: string;
  logFailure?: boolean;
  // Keys to remove from the child process environment. Used in place of a
  // platform-specific `env -u` wrapper so the same call works on Windows,
  // which has no `env` binary in cmd.exe/PowerShell.
  unsetEnv?: string[];
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

function getExecEnv(unsetKeys?: readonly string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...getIsolatedEnv(),
    PATH: getEnhancedPath(),
  };

  if (process.platform === 'win32') {
    delete env.Path;
  }

  if (unsetKeys) {
    for (const key of unsetKeys) {
      delete env[key];
    }
  }

  return env;
}

export async function exec(command: string, options?: ExecOptions): Promise<string> {
  const startedAt = Date.now();
  const cwd = options?.cwd;
  logger.debug('exec.start', 'Running shell command', { command, cwd });
  // On Windows the console writes in the active OEM code page (CP936 for
  // zh-CN, CP932 for ja-JP, CP437 for en-US, etc.), not UTF-8. The default
  // string decoder in child_process therefore garbles non-ASCII output and
  // error messages. Capture raw bytes and decode them through iconv-lite.
  const codec = IS_WINDOWS ? getWindowsConsoleCodec() : 'utf8';
  try {
    const { stdout } = IS_WINDOWS
      ? await execPromise(command, {
          cwd,
          env: getExecEnv(options?.unsetEnv),
          encoding: 'buffer',
        })
      : await execPromise(command, {
          cwd,
          env: getExecEnv(options?.unsetEnv),
        });
    const decodedStdout = IS_WINDOWS ? decodeChildOutput(stdout, codec) : (stdout as string);
    logger.debug('exec.success', 'Shell command completed', {
      command,
      cwd,
      durationMs: Date.now() - startedAt,
      stdoutLength: decodedStdout.length,
    });
    return decodedStdout.trim();
  } catch (error) {
    const failure = error as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (IS_WINDOWS) {
      // Node attaches the captured Buffers to the rejected error when
      // `encoding: 'buffer'` is set. Decode them in place so downstream
      // log lines, error messages, and any caller that reads .stdout /
      // .stderr off the error see readable text rather than mojibake.
      const decodedStdout = failure.stdout !== undefined
        ? decodeChildOutput(failure.stdout, codec)
        : undefined;
      const decodedStderr = failure.stderr !== undefined
        ? decodeChildOutput(failure.stderr, codec)
        : undefined;
      if (decodedStdout !== undefined) failure.stdout = decodedStdout;
      if (decodedStderr !== undefined) failure.stderr = decodedStderr;
      // Node builds .message from the raw stderr Buffer via Buffer.toString()
      // (UTF-8), so on a non-UTF-8 Windows console the message itself is
      // still mojibake even after we fix .stdout / .stderr. Most callers log
      // error.message (including the JSON log line in the user report that
      // started this fix). Rebuild it from the iconv-decoded stderr, but
      // only when the message has Node's "Command failed:" prefix, so we
      // don't clobber errors thrown from elsewhere.
      if (
        typeof failure.message === 'string'
        && failure.message.startsWith('Command failed:')
      ) {
        failure.message = decodedStderr
          ? `Command failed: ${command}\n${decodedStderr}`
          : `Command failed: ${command}`;
      }
    }
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
