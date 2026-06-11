import { AgentType, CopilotMode } from './types';

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', sudocode: 'Sudo Code', custom: 'Custom',
};

export const DEFAULT_AGENT_COMMANDS: Record<string, string> = {
  claude: 'claude', codex: 'codex', gemini: 'gemini', sudocode: 'scode',
};

/** Per-agent flag to enable full auto-approve (skip all permission prompts) */
export const AGENT_YOLO_FLAGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
  gemini: '--yolo --skip-trust',
  sudocode: '--dangerously-skip-permissions',
};

/**
 * Session ID capture configuration per agent.
 *
 * - Claude Code: uses --session-id flag at launch (no capture needed)
 * - Codex CLI (>= 0.1.2025042500): /status command, parse session ID from output
 * - Gemini CLI (>= 0.5.0): /stats command, parse session ID from output
 */
export interface SessionCaptureConfig {
  /** Slash command to query agent status */
  statusCommand: string;
  /** Regex to extract session ID from captured pane output (first capture group) */
  sessionIdPattern: RegExp;
  /** Optional regex to extract the agent transcript file path (first capture group) */
  sessionFilePattern?: RegExp;
  /** Delay (ms) before sending status command, to wait for agent readiness */
  readyDelayMs: number;
  /** Delay (ms) after sending status command, before capturing pane output */
  captureDelayMs: number;
}

export const AGENT_SESSION_CAPTURE: Partial<Record<string, SessionCaptureConfig>> = {
  codex: {
    statusCommand: '/status',
    sessionIdPattern: /Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    readyDelayMs: 8000,
    captureDelayMs: 2000,
  },
  gemini: {
    statusCommand: '/stats',
    sessionIdPattern: /Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    readyDelayMs: 15000,
    captureDelayMs: 2000,
  },
  sudocode: {
    statusCommand: '/status',
    sessionIdPattern: /Session\s+(session-\d+-\d+)\b/,
    sessionFilePattern: /Auto-save\s+(.+?\.jsonl)/,
    readyDelayMs: 8000,
    captureDelayMs: 1000,
  },
};

/** Delay (ms) for Claude before sending task (agent needs time to start) — used as fallback timeout */
export const CLAUDE_READY_DELAY_MS = 5000;

/**
 * Ready indicator patterns per agent type.
 * Poll tmux pane output for these patterns to detect when the agent TUI is ready.
 *
 * Claude Code's trust prompt uses both ❯ (selection indicator) and ─ (separator),
 * so neither alone is sufficient. The status bar with ⏵ only appears once the TUI
 * is fully initialized and at the idle input prompt.
 */
export const AGENT_READY_PATTERNS: Record<string, RegExp> = {
  claude: /⏵/,
  codex: /⏵|(?:^|\n)\s*›\s*/m,
  gemini: /⏵/,
  sudocode: /(?:^|\n)\s*❯\s*/m,
};

export const AGENT_COMPLETION_NOTIFICATIONS: Record<string, boolean> = {
  claude: true,
  codex: true,
  gemini: true,
  sudocode: false,
  custom: false,
};

export function agentSupportsCompletionNotification(agentType: string): boolean {
  return AGENT_COMPLETION_NOTIFICATIONS[agentType] === true;
}

export function agentSupportsCopilotMode(agentType: string, copilotMode: CopilotMode): boolean {
  if (copilotMode === 'normal') {
    return true;
  }
  return agentType === 'claude' || agentType === 'codex';
}

export function getUnsupportedCopilotModeMessage(agentType: string, copilotMode: CopilotMode): string {
  if (copilotMode === 'plan') {
    return `Planner mode is currently supported for Claude and Codex only. Agent "${agentType}" is not supported.`;
  }
  return `Copilot mode "${copilotMode}" is not supported for agent "${agentType}".`;
}

export function extractAgentCommandExecutable(command: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return '';
  }

  if (!isEnvExecutable(tokens[0])) {
    return tokens[0];
  }

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-S') {
      return extractAgentCommandExecutable(tokens[index + 1] ?? '');
    }
    if (token === '-u' || token === '--unset') {
      index += 1;
      continue;
    }
    if (token === '-i' || token === '-' || token === '--ignore-environment') {
      continue;
    }
    if (token.startsWith('-u') && token.length > 2) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return token;
  }

  return tokens[0];
}

/**
 * Pattern to detect the Claude trust prompt ("Do you trust this folder?").
 * When detected, send Enter to accept it before waiting for the actual input prompt.
 */
export const CLAUDE_TRUST_PROMPT_PATTERN = /trust this folder/;

/**
 * Codex can ask which working directory to use when a session is resumed on
 * another machine/path. Hydra passes -C where possible, but accepts the prompt
 * as a fallback for older/newer Codex picker flows.
 */
export const CODEX_RESUME_CWD_PROMPT_PATTERN = /Choose working directory to resume this session/i;

/** Codex asks before loading project-local config/hooks from a new worktree. */
export const CODEX_TRUST_PROMPT_PATTERN = /Do you trust the contents of this directory/i;

/** Codex requires review before newly injected hooks become active. */
export const CODEX_HOOK_REVIEW_PROMPT_PATTERN = /Hooks need review|hook needs review before it can run|Trust all and continue/i;

/** Gemini asks before loading project-local settings/hooks from a new worktree. */
export const GEMINI_TRUST_PROMPT_PATTERN = /Do you trust the files in this folder\?|Trust folder/i;

/** Sudo Code asks for explicit confirmation when launched from a broad directory. */
export const SUDOCODE_BROAD_DIRECTORY_PROMPT_PATTERN = /Continue anyway\?\s+\[y\/N\]:/i;

/** Maximum time (ms) to wait for agent readiness before giving up */
export const AGENT_READY_TIMEOUT_MS = 30000;

/** Polling interval (ms) when waiting for agent readiness */
export const AGENT_READY_POLL_INTERVAL_MS = 500;

function appendCommandArgs(command: string, ...args: string[]): string {
  return [command.trim(), ...args.map(arg => arg.trim()).filter(Boolean)].join(' ');
}

function ensureCommandFlag(command: string, flag: string): string {
  const trimmed = command.trim();
  if (!flag || trimmed.includes(flag)) {
    return trimmed;
  }
  return appendCommandArgs(trimmed, flag);
}

function ensureStandaloneCommandFlags(command: string, flags: string): string {
  return flags
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((current, flag) => ensureCommandFlag(current, flag), command.trim());
}

function prepareCommandForShell(command: string, target?: ShellTarget): string {
  if (target !== 'pwsh') {
    return command;
  }

  const trimmed = command.trim();
  if (/^&\s+/.test(trimmed)) {
    return trimmed;
  }

  // PowerShell treats a leading quoted executable path as a string expression.
  // Use the call operator so commands like `"C:\Program Files\tool.exe" --flag`
  // actually execute instead of failing with UnexpectedToken.
  if (/^"[A-Za-z]:\\[^"]+\.(?:exe|cmd|bat|ps1)"(?:\s|$)/i.test(trimmed)) {
    return `& ${trimmed}`;
  }

  return trimmed;
}

// Which shell will execute the launch/resume command string we build below.
// `posix` is POSIX `sh`-family (default on macOS/Linux). On Windows the value
// depends on the psmux pane's default-shell — `cmd` (cmd.exe) or `pwsh`
// (powershell.exe / pwsh.exe). See issue #225 §7.
export type ShellTarget = 'posix' | 'cmd' | 'pwsh';

export function defaultShellTarget(): ShellTarget {
  return process.platform === 'win32' ? 'pwsh' : 'posix';
}

export interface AgentCommandOptions {
  copilotMode?: CopilotMode;
  shellTarget?: ShellTarget;
}

const PLAN_UNSAFE_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--yolo',
  '--skip-trust',
];

function isPlanCopilot(options?: AgentCommandOptions): boolean {
  return options?.copilotMode === 'plan';
}

function assertPlanCommandIsSafe(agentBinary: string): void {
  const tokens = tokenizeCommand(agentBinary);
  const unsafe = PLAN_UNSAFE_FLAGS.find(flag => tokens.includes(flag));
  if (unsafe) {
    throw new Error(`Planner mode cannot use unsafe agent flag "${unsafe}". Remove it from the configured agent command.`);
  }
}

function buildAgentBaseCommand(
  agentType: string,
  agentBinary: string,
  options?: AgentCommandOptions,
): string {
  if (!isPlanCopilot(options)) {
    const yolo = AGENT_YOLO_FLAGS[agentType] || '';
    return prepareCommandForShell(
      ensureStandaloneCommandFlags(agentBinary, yolo),
      options?.shellTarget,
    );
  }

  assertPlanCommandIsSafe(agentBinary);

  switch (agentType) {
    case 'claude':
      return prepareCommandForShell(
        ensureCommandFlag(agentBinary, '--permission-mode plan'),
        options?.shellTarget,
      );
    case 'codex': {
      let command = ensureCommandFlag(agentBinary, '--sandbox read-only');
      command = ensureCommandFlag(command, '--ask-for-approval never');
      return prepareCommandForShell(command, options?.shellTarget);
    }
    default:
      throw new Error(getUnsupportedCopilotModeMessage(agentType, 'plan'));
  }
}

/**
 * Build the shell command to RESUME an existing agent session.
 * Returns null if the agent type doesn't support resume.
 */
export function buildAgentResumeCommand(
  agentType: string,
  agentBinary: string,
  sessionId: string,
  workdir?: string,
  options?: AgentCommandOptions,
): string | null {
  const plan = buildAgentResumePlan(agentType, agentBinary, sessionId, workdir, null, options);
  return plan?.strategy === 'command' ? plan.command : null;
}

export type AgentResumePlan =
  | { strategy: 'command'; command: string }
  | { strategy: 'replSlashCommand'; command: string; slashCommand: string };

/**
 * Build the shell command and optional in-REPL slash command needed to resume
 * an existing agent session.
 */
export function buildAgentResumePlan(
  agentType: string,
  agentBinary: string,
  sessionId: string,
  workdir?: string,
  sessionFile?: string | null,
  options?: AgentCommandOptions,
): AgentResumePlan | null {
  const target = options?.shellTarget;
  const quotedSessionId = shellQuoteForDisplay(sessionId, target);
  switch (agentType) {
    case 'claude': {
      const command = isPlanCopilot(options)
        ? buildAgentBaseCommand(agentType, agentBinary, options)
        : agentBinary;
      return { strategy: 'command', command: appendCommandArgs(command, `--resume ${quotedSessionId}`) };
    }
    case 'codex': {
      const command = buildAgentBaseCommand(agentType, agentBinary, options);
      const cdArgs = workdir ? ['-C', shellQuoteForDisplay(workdir, target)] : [];
      return { strategy: 'command', command: appendCommandArgs(command, 'resume', ...cdArgs, quotedSessionId) };
    }
    case 'gemini':
      if (isPlanCopilot(options)) {
        throw new Error(getUnsupportedCopilotModeMessage(agentType, 'plan'));
      }
      return { strategy: 'command', command: appendCommandArgs(agentBinary, `--resume ${quotedSessionId}`) };
    case 'sudocode': {
      const command = buildAgentBaseCommand(agentType, agentBinary, options);
      const resumeRef = sessionFile?.trim() || sessionId;
      return {
        strategy: 'replSlashCommand',
        command,
        // Sudo Code parses /resume by taking the full remainder after the
        // command name, so paths with spaces must be sent raw. Shell-style
        // quotes would become part of the path.
        slashCommand: `/resume ${resumeRef}`,
      };
    }
    default:
      return null;
  }
}

/** Build the shell command to launch an agent (matches bash CLI get_agent_command) */
export function buildAgentLaunchCommand(
  agentType: string,
  agentBinary: string,
  task?: string,
  sessionId?: string,
  options?: AgentCommandOptions,
): string {
  const command = buildAgentBaseCommand(agentType, agentBinary, options);
  const target = options?.shellTarget;

  switch (agentType) {
    case 'claude': {
      let launchCommand = command;
      if (sessionId) {
        launchCommand = appendCommandArgs(
          launchCommand,
          `--session-id ${shellQuoteForDisplay(sessionId, target)}`,
        );
      }
      return task ? `${launchCommand} -- ${shellQuoteForDisplay(task, target)}` : launchCommand;
    }
    case 'codex':
      return task
        ? appendCommandArgs(command, shellQuoteForDisplay(task, target))
        : command;
    case 'gemini':
      return task
        ? appendCommandArgs(command, shellQuoteForDisplay(task, target))
        : command;
    case 'sudocode':
      return command;
    default:
      return agentBinary;
  }
}

// Quote a value for the target shell. Both the agent launch/resume command
// and the env prefix that wraps it must agree on which shell will parse them,
// so we accept the target explicitly instead of hard-coding by platform. See
// issue #225 §7.
export function shellQuoteForDisplay(s: string, target?: ShellTarget): string {
  const t = target ?? defaultShellTarget();
  switch (t) {
    case 'posix':
      // POSIX single-quote literal — no expansion of `$VAR`/`` ` `` inside.
      return `'${s.replace(/'/g, "'\\''")}'`;
    case 'pwsh':
      // PowerShell double-quote string — backtick is the escape char.
      return `"${s.replace(/[`"$]/g, '`$&')}"`;
    case 'cmd':
      // cmd.exe `"…"` — embedded double quotes are doubled. (`$` and backtick
      // are literal to cmd.)
      return `"${s.replace(/"/g, '""')}"`;
  }
}

function isEnvExecutable(token: string): boolean {
  return /(^|[/\\])env(?:\.exe)?$/.test(token);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}
