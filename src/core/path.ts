import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { shellQuote } from './shell';

function expandHomeDir(targetPath: string): string {
  if (targetPath === '~') return os.homedir();
  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

export function toCanonicalPath(targetPath?: string): string | undefined {
  if (!targetPath) return undefined;

  const expanded = expandHomeDir(targetPath.trim());
  return path.normalize(path.resolve(expanded));
}

/**
 * Resolves the on-disk transcript file for a given agent session.
 *   - claude:  ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl
 *              (workdir encoded by replacing `/`, `\`, `.`, `:`, and whitespace
 *              with `-`, mirroring Claude Code's own slugify behavior on POSIX
 *              and Windows)
 *   - codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<datetime>-<sessionId>.jsonl
 *              (UUIDv7 sessionIds let us probe the date directory in O(1);
 *              falls back to a recursive scan otherwise)
 *   - gemini:  ~/.gemini/tmp/<projectName>/logs.json
 *              (projectName looked up by workdir in ~/.gemini/projects.json;
 *              the file is per-project and may contain multiple sessions)
 *   - sudocode:
 *              <workdir>/.scode/sessions/<workspace-hash>/<sessionId>.jsonl
 * Returns null when the agent is unknown, required inputs are missing, or the
 * file does not exist.
 */
export function resolveAgentSessionFile(
  agent: string,
  workdir: string,
  sessionId: string | null,
  persistedSessionFile?: string | null,
): string | null {
  if (persistedSessionFile && fs.existsSync(persistedSessionFile)) {
    if (agent !== 'sudocode' || sudoCodeSessionMatchesWorkdir(persistedSessionFile, workdir)) {
      return persistedSessionFile;
    }
  }

  switch (agent) {
    case 'claude':
      return resolveClaudeSessionFile(workdir, sessionId);
    case 'codex':
      return resolveCodexSessionFile(sessionId);
    case 'gemini':
      return resolveGeminiSessionFile(workdir);
    case 'sudocode':
      return resolveSudoCodeSessionFile(workdir, sessionId);
    default:
      return null;
  }
}

function resolveClaudeSessionFile(workdir: string, sessionId: string | null): string | null {
  if (!workdir || !sessionId) return null;
  const encoded = encodeClaudeWorkdir(workdir);
  const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Encodes a workdir into Claude Code's project directory slug. Replaces path
 * separators (`/`, `\`), drive-letter colons, dots, and whitespace with `-`
 * so the rule works for both POSIX (`/Users/x/.foo`) and Windows
 * (`C:\Users\x\proj`) workdirs.
 */
export function encodeClaudeWorkdir(workdir: string): string {
  return workdir.replace(/[/\\.:\s]/g, '-');
}

function resolveCodexSessionFile(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return null;

  // Fast path: codex uses UUIDv7 ids whose first 48 bits encode unix ms, and
  // it partitions storage by UTC date — so we can usually probe a single dir
  // instead of walking the whole tree.
  const direct = probeCodexDateDir(root, sessionId);
  if (direct) return direct;

  return scanCodexSessions(root, sessionId);
}

function probeCodexDateDir(root: string, sessionId: string): string | null {
  const compact = sessionId.replace(/-/g, '');
  // UUIDv7: 13th hex character (after dashes stripped) is the version `7`.
  if (compact.length < 13 || compact[12] !== '7') return null;
  const ms = parseInt(compact.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;

  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const dir = path.join(root, yyyy, mm, dd);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const suffix = `-${sessionId}.jsonl`;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
      return path.join(dir, entry.name);
    }
  }
  return null;
}

function scanCodexSessions(root: string, sessionId: string): string | null {
  const suffix = `-${sessionId}.jsonl`;
  // Walk ~/.codex/sessions/YYYY/MM/DD/ for a file named rollout-*-<sessionId>.jsonl.
  // Newest dates first so the common case (recent session) hits early.
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirs.push(entry.name);
      } else if (
        entry.isFile()
        && entry.name.startsWith('rollout-')
        && entry.name.endsWith(suffix)
      ) {
        return path.join(dir, entry.name);
      }
    }
    // Push subdirs in ascending order so the largest (newest) is popped first.
    subdirs.sort();
    for (const name of subdirs) {
      stack.push(path.join(dir, name));
    }
  }
  return null;
}

function resolveGeminiSessionFile(workdir: string): string | null {
  if (!workdir) return null;
  const projectsFile = path.join(os.homedir(), '.gemini', 'projects.json');
  if (!fs.existsSync(projectsFile)) return null;

  let projects: Record<string, string>;
  try {
    const raw = JSON.parse(fs.readFileSync(projectsFile, 'utf-8'));
    const map = raw?.projects;
    if (!map || typeof map !== 'object') return null;
    projects = map as Record<string, string>;
  } catch {
    return null;
  }

  // Gemini stores keys produced by Node's path.resolve(); incoming workdirs may
  // have trailing slashes or differ in casing on case-insensitive filesystems.
  // Try an exact lookup first, then fall back to a normalized comparison.
  let projectName: string | undefined = projects[workdir];
  if (!projectName) {
    const normalizedTarget = toCanonicalPath(workdir);
    if (normalizedTarget) {
      for (const [key, value] of Object.entries(projects)) {
        if (toCanonicalPath(key) === normalizedTarget) {
          projectName = value;
          break;
        }
      }
    }
  }
  if (!projectName) return null;

  const logsFile = path.join(os.homedir(), '.gemini', 'tmp', projectName, 'logs.json');
  return fs.existsSync(logsFile) ? logsFile : null;
}

function resolveSudoCodeSessionFile(workdir: string, sessionId: string | null): string | null {
  if (!workdir || !sessionId) return null;
  const root = path.join(workdir, '.scode', 'sessions');
  if (!fs.existsSync(root)) return null;

  const filename = `${sessionId}.jsonl`;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === filename &&
        sudoCodeSessionMatchesWorkdir(entryPath, workdir)
      ) {
        return entryPath;
      }
    }
  }

  return null;
}

function sudoCodeSessionMatchesWorkdir(sessionFile: string, workdir: string): boolean {
  const workspaceRoot = readSudoCodeWorkspaceRoot(sessionFile);
  if (!workspaceRoot || !workdir) {
    return true;
  }

  const sessionRoot = toCanonicalPath(workspaceRoot);
  const targetRoot = toCanonicalPath(workdir);
  if (!sessionRoot || !targetRoot) {
    return true;
  }
  if (sessionRoot === targetRoot) {
    return true;
  }

  try {
    return fs.realpathSync.native(sessionRoot) === fs.realpathSync.native(targetRoot);
  } catch {
    return false;
  }
}

function readSudoCodeWorkspaceRoot(sessionFile: string): string | null {
  try {
    const raw = fs.readFileSync(sessionFile, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed?.type === 'session_meta') {
        return typeof parsed.workspace_root === 'string' ? parsed.workspace_root : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface HydraCliConfig {
  extensionPath?: string;
  version?: string;
}

export interface HydraShareConfig {
  bucket?: string;
  prefix?: string;
  publicBaseUrl?: string;
}

export interface HydraGlobalConfig {
  hydraHome?: string;
  hydraConfigPath?: string;
  HYDRA_HOME?: string;
  HYDRA_CONFIG_PATH?: string;
  cli?: HydraCliConfig;
  share?: HydraShareConfig;
}

export interface HydraResolvedPaths {
  hydraHome: string;
  hydraConfigPath: string;
  hydraConfig: HydraGlobalConfig;
  hydraBinDir: string;
  hydraSessionsFile: string;
  hydraArchiveFile: string;
  hydraWorktreesRoot: string;
  hydraReposRoot: string;
}

export function getDefaultHydraHome(): string {
  return path.join(os.homedir(), '.hydra');
}

function resolveConfigPathValue(value: unknown, configPath: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const expanded = expandHomeDir(value.trim());
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(path.dirname(configPath), expanded);
  return path.normalize(absolute);
}

function getConfigHydraHome(config: HydraGlobalConfig): string | undefined {
  return config.hydraHome || config.HYDRA_HOME;
}

function getConfigHydraConfigPath(config: HydraGlobalConfig): string | undefined {
  return config.hydraConfigPath || config.HYDRA_CONFIG_PATH;
}

function readHydraConfigFile(configPath: string): HydraGlobalConfig {
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return raw && typeof raw === 'object' ? raw as HydraGlobalConfig : {};
  } catch {
    return {};
  }
}

export function getHydraPaths(): HydraResolvedPaths {
  const defaultHydraHome = getDefaultHydraHome();
  const envHydraHome = toCanonicalPath(process.env.HYDRA_HOME);
  const envHydraConfigPath = toCanonicalPath(process.env.HYDRA_CONFIG_PATH);

  const bootstrapConfigPath = envHydraConfigPath
    || path.join(envHydraHome || defaultHydraHome, 'config.json');

  let hydraConfig = readHydraConfigFile(bootstrapConfigPath);
  let hydraHome = envHydraHome
    || resolveConfigPathValue(getConfigHydraHome(hydraConfig), bootstrapConfigPath)
    || defaultHydraHome;
  let hydraConfigPath = envHydraConfigPath
    || resolveConfigPathValue(getConfigHydraConfigPath(hydraConfig), bootstrapConfigPath)
    || path.join(hydraHome, 'config.json');

  if (!envHydraConfigPath && hydraConfigPath !== bootstrapConfigPath && fs.existsSync(hydraConfigPath)) {
    hydraConfig = readHydraConfigFile(hydraConfigPath);
    hydraHome = envHydraHome
      || resolveConfigPathValue(getConfigHydraHome(hydraConfig), hydraConfigPath)
      || hydraHome;
    hydraConfigPath = envHydraConfigPath
      || resolveConfigPathValue(getConfigHydraConfigPath(hydraConfig), hydraConfigPath)
      || hydraConfigPath;
  }

  return {
    hydraHome,
    hydraConfigPath,
    hydraConfig,
    hydraBinDir: path.join(hydraHome, 'bin'),
    hydraSessionsFile: path.join(hydraHome, 'sessions.json'),
    hydraArchiveFile: path.join(hydraHome, 'archive.json'),
    hydraWorktreesRoot: path.join(hydraHome, 'worktrees'),
    hydraReposRoot: path.join(hydraHome, 'repos'),
  };
}

export function getHydraHome(): string {
  return getHydraPaths().hydraHome;
}

export function getHydraConfigPath(): string {
  return getHydraPaths().hydraConfigPath;
}

export function getHydraConfig(): HydraGlobalConfig {
  return getHydraPaths().hydraConfig;
}

export function writeHydraConfig(config: HydraGlobalConfig): void {
  const { hydraConfigPath } = getHydraPaths();
  fs.mkdirSync(path.dirname(hydraConfigPath), { recursive: true });
  fs.writeFileSync(hydraConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function getHydraBinDir(): string {
  return getHydraPaths().hydraBinDir;
}

export function getHydraSessionsFile(): string {
  return getHydraPaths().hydraSessionsFile;
}

export function getHydraArchiveFile(): string {
  return getHydraPaths().hydraArchiveFile;
}

export function getHydraWorktreesRoot(): string {
  return getHydraPaths().hydraWorktreesRoot;
}

export function getHydraReposRoot(): string {
  return getHydraPaths().hydraReposRoot;
}

export function getIsolatedEnv(): Record<string, string | undefined> {
  const { hydraHome, hydraConfigPath } = getHydraPaths();
  const env: Record<string, string | undefined> = { ...process.env };
  env.HYDRA_HOME = hydraHome;
  env.HYDRA_CONFIG_PATH = hydraConfigPath;
  if (process.env.HYDRA_TMUX_SOCKET) {
    env.HYDRA_TMUX_SOCKET = process.env.HYDRA_TMUX_SOCKET;
  }
  return env;
}

export function getTmuxSocketArgs(): string[] {
  const socket = process.env.HYDRA_TMUX_SOCKET;
  if (!socket) {
    return [];
  }

  if (socket.startsWith('/') || socket.startsWith('./') || socket.startsWith('../')) {
    return ['-S', socket];
  }

  return ['-L', socket];
}

export function getTmuxCommand(): string {
  const binary = process.platform === 'win32' ? 'psmux' : 'tmux';
  const socketArgs = getTmuxSocketArgs();
  if (socketArgs.length === 0) {
    return binary;
  }

  return `${binary} ${socketArgs.map(arg => shellQuote(arg)).join(' ')}`;
}
