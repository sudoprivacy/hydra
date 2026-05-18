import { AgentType } from './types';

export const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', sudocode: 'Sudo Code', custom: 'Custom',
};

export const DEFAULT_AGENT_COMMANDS: Record<string, string> = {
  claude: 'claude', codex: 'codex', gemini: 'gemini', sudocode: 'scode',
};

/** Per-agent flag to enable full auto-approve (skip all permission prompts) */
export const AGENT_YOLO_FLAGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
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

/**
 * Build the shell command to RESUME an existing agent session.
 * Returns null if the agent type doesn't support resume.
 */
export function buildAgentResumeCommand(
  agentType: string,
  agentBinary: string,
  sessionId: string,
  workdir?: string,
): string | null {
  const plan = buildAgentResumePlan(agentType, agentBinary, sessionId, workdir);
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
): AgentResumePlan | null {
  const quotedSessionId = shellQuoteForDisplay(sessionId);
  switch (agentType) {
    case 'claude': {
      return { strategy: 'command', command: appendCommandArgs(agentBinary, `--resume ${quotedSessionId}`) };
    }
    case 'codex': {
      const command = ensureCommandFlag(agentBinary, AGENT_YOLO_FLAGS.codex);
      const cdArgs = workdir ? ['-C', shellQuoteForDisplay(workdir)] : [];
      return { strategy: 'command', command: appendCommandArgs(command, 'resume', ...cdArgs, quotedSessionId) };
    }
    case 'gemini':
      return { strategy: 'command', command: appendCommandArgs(agentBinary, `--resume ${quotedSessionId}`) };
    case 'sudocode': {
      const command = ensureCommandFlag(agentBinary, AGENT_YOLO_FLAGS.sudocode);
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
): string {
  const yolo = AGENT_YOLO_FLAGS[agentType] || '';
  const command = ensureCommandFlag(agentBinary, yolo);

  switch (agentType) {
    case 'claude': {
      let launchCommand = command;
      if (sessionId) {
        launchCommand = appendCommandArgs(
          launchCommand,
          `--session-id ${shellQuoteForDisplay(sessionId)}`,
        );
      }
      return task ? `${launchCommand} -- ${shellQuoteForDisplay(task)}` : launchCommand;
    }
    case 'codex':
      return task
        ? appendCommandArgs(command, shellQuoteForDisplay(task))
        : command;
    case 'gemini':
      return task
        ? appendCommandArgs(command, shellQuoteForDisplay(task))
        : command;
    case 'sudocode':
      return command;
    default:
      return agentBinary;
  }
}

function shellQuoteForDisplay(s: string): string {
  if (process.platform === 'win32') {
    // PowerShell double-quote escaping: escape backticks and double-quotes
    return `"${s.replace(/[`"$]/g, '`$&')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
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
