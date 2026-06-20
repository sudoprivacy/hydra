import { AgentType, CopilotMode } from './types';

export type ShellTarget = 'posix' | 'cmd' | 'pwsh';

export interface AgentCommandOptions {
  copilotMode?: CopilotMode;
  shellTarget?: ShellTarget;
}

export type AgentResumePlan =
  | { strategy: 'command'; command: string }
  | { strategy: 'replSlashCommand'; command: string; slashCommand: string };

export type AgentPromptAction =
  | { kind: 'sendKeys'; keys: string }
  | { kind: 'wait' };

export interface AgentPromptHandler {
  id: string;
  pattern: RegExp;
  once?: boolean;
  blocksReadiness?: boolean;
  handle(output: string): AgentPromptAction | null;
}

export interface AgentReadyConfig {
  pattern?: RegExp;
  fallbackDelayMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
  promptHandlers?: AgentPromptHandler[];
  additionalBlockingPatterns?: RegExp[];
}

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

export interface AgentLaunchContext {
  agentType: string;
  agentCommand: string;
  task?: string;
  sessionId?: string;
  copilotMode?: CopilotMode;
  shellTarget?: ShellTarget;
}

export interface AgentResumeContext {
  agentCommand: string;
  sessionId: string;
  workdir?: string;
  sessionFile?: string | null;
  copilotMode?: CopilotMode;
  shellTarget?: ShellTarget;
}

export interface AgentResumeConfig {
  buildPlan(context: AgentResumeContext): AgentResumePlan | null;
  requiresSessionFile?: boolean;
  waitForSlashCommandReady?: 'default' | 'sudocodeSessionResumed';
}

export interface AgentDefinition {
  id: AgentType;
  label: string;
  defaultCommand?: string;
  yoloFlags?: string;
  supportsPlanMode: boolean;
  supportsCompletionNotification: boolean;
  preassignSessionId?: boolean;
  launch: {
    buildCommand(context: AgentLaunchContext): string;
  };
  resume?: AgentResumeConfig;
  ready?: AgentReadyConfig;
  sessionCapture?: SessionCaptureConfig;
}

/** Delay (ms) for unknown agents before sending task — used as fallback timeout */
export const CLAUDE_READY_DELAY_MS = 5000;

/** Maximum time (ms) to wait for agent readiness before giving up */
export const AGENT_READY_TIMEOUT_MS = 30000;

/** Polling interval (ms) when waiting for agent readiness */
export const AGENT_READY_POLL_INTERVAL_MS = 500;

/**
 * Pattern to detect the Claude trust prompt ("Do you trust this folder?").
 * This is intentionally a global ready handler: current SessionManager checks
 * it for every agent before agent-specific prompts.
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

const PLAN_UNSAFE_FLAGS = [
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--yolo',
  '--skip-trust',
];

const AGENT_DEFINITION_ORDER: AgentType[] = ['claude', 'codex', 'gemini', 'sudocode', 'custom'];

export const GLOBAL_READY_PROMPT_HANDLERS: AgentPromptHandler[] = [
  {
    id: 'claude-trust-folder',
    pattern: CLAUDE_TRUST_PROMPT_PATTERN,
    once: true,
    handle: () => ({ kind: 'sendKeys', keys: '' }),
  },
];

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

export function defaultShellTarget(): ShellTarget {
  return process.platform === 'win32' ? 'pwsh' : 'posix';
}

function isPlanCopilot(options?: AgentCommandOptions): boolean {
  return options?.copilotMode === 'plan';
}

function assertPlanCommandIsSafe(agentCommand: string): void {
  const tokens = tokenizeCommand(agentCommand);
  const unsafe = PLAN_UNSAFE_FLAGS.find(flag => tokens.includes(flag));
  if (unsafe) {
    throw new Error(`Planner mode cannot use unsafe agent flag "${unsafe}". Remove it from the configured agent command.`);
  }
}

function getPlanCommand(agentType: string, agentCommand: string, options?: AgentCommandOptions): string {
  assertPlanCommandIsSafe(agentCommand);

  switch (agentType) {
    case 'claude':
      return prepareCommandForShell(
        ensureCommandFlag(agentCommand, '--permission-mode plan'),
        options?.shellTarget,
      );
    case 'codex': {
      let command = ensureCommandFlag(agentCommand, '--sandbox read-only');
      command = ensureCommandFlag(command, '--ask-for-approval never');
      return prepareCommandForShell(command, options?.shellTarget);
    }
    default:
      throw new Error(getUnsupportedCopilotModeMessage(agentType, 'plan'));
  }
}

function buildAgentBaseCommand(
  definition: AgentDefinition,
  agentCommand: string,
  options?: AgentCommandOptions,
): string {
  if (!isPlanCopilot(options)) {
    return prepareCommandForShell(
      ensureStandaloneCommandFlags(agentCommand, definition.yoloFlags || ''),
      options?.shellTarget,
    );
  }

  return getPlanCommand(definition.id, agentCommand, options);
}

function buildCustomLaunchCommand(context: AgentLaunchContext): string {
  if (context.copilotMode === 'plan') {
    assertPlanCommandIsSafe(context.agentCommand);
    throw new Error(getUnsupportedCopilotModeMessage(context.agentType, 'plan'));
  }
  return context.agentCommand;
}

const BUILT_IN_AGENT_DEFINITIONS: Record<AgentType, AgentDefinition> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    defaultCommand: 'claude',
    yoloFlags: '--dangerously-skip-permissions',
    supportsPlanMode: true,
    supportsCompletionNotification: true,
    preassignSessionId: true,
    launch: {
      buildCommand: (context) => {
        let launchCommand = buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.claude, context.agentCommand, context);
        if (context.sessionId) {
          launchCommand = appendCommandArgs(
            launchCommand,
            `--session-id ${shellQuoteForDisplay(context.sessionId, context.shellTarget)}`,
          );
        }
        return context.task
          ? `${launchCommand} -- ${shellQuoteForDisplay(context.task, context.shellTarget)}`
          : launchCommand;
      },
    },
    resume: {
      buildPlan: (context) => {
        const command = isPlanCopilot(context)
          ? buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.claude, context.agentCommand, context)
          : context.agentCommand;
        return {
          strategy: 'command',
          command: appendCommandArgs(
            command,
            `--resume ${shellQuoteForDisplay(context.sessionId, context.shellTarget)}`,
          ),
        };
      },
    },
    ready: {
      pattern: /⏵/,
      fallbackDelayMs: CLAUDE_READY_DELAY_MS,
      timeoutMs: AGENT_READY_TIMEOUT_MS,
      pollIntervalMs: AGENT_READY_POLL_INTERVAL_MS,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    defaultCommand: 'codex',
    yoloFlags: '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    supportsPlanMode: true,
    supportsCompletionNotification: true,
    launch: {
      buildCommand: (context) => {
        const command = buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.codex, context.agentCommand, context);
        return context.task
          ? appendCommandArgs(command, shellQuoteForDisplay(context.task, context.shellTarget))
          : command;
      },
    },
    resume: {
      buildPlan: (context) => {
        const command = buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.codex, context.agentCommand, context);
        const cdArgs = context.workdir ? ['-C', shellQuoteForDisplay(context.workdir, context.shellTarget)] : [];
        return {
          strategy: 'command',
          command: appendCommandArgs(
            command,
            'resume',
            ...cdArgs,
            shellQuoteForDisplay(context.sessionId, context.shellTarget),
          ),
        };
      },
    },
    ready: {
      pattern: /⏵|(?:^|\n)\s*›\s*/m,
      fallbackDelayMs: CLAUDE_READY_DELAY_MS,
      timeoutMs: AGENT_READY_TIMEOUT_MS,
      pollIntervalMs: AGENT_READY_POLL_INTERVAL_MS,
      promptHandlers: [
        {
          id: 'codex-trust-directory',
          pattern: CODEX_TRUST_PROMPT_PATTERN,
          once: true,
          blocksReadiness: true,
          handle: () => ({ kind: 'sendKeys', keys: '' }),
        },
        {
          id: 'codex-hook-review',
          pattern: CODEX_HOOK_REVIEW_PROMPT_PATTERN,
          once: true,
          blocksReadiness: true,
          handle: () => ({ kind: 'sendKeys', keys: 'Down' }),
        },
        {
          id: 'codex-resume-cwd-picker',
          pattern: CODEX_RESUME_CWD_PROMPT_PATTERN,
          once: true,
          blocksReadiness: true,
          handle: () => ({ kind: 'sendKeys', keys: '' }),
        },
      ],
    },
    sessionCapture: {
      statusCommand: '/status',
      sessionIdPattern: /Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      readyDelayMs: 8000,
      captureDelayMs: 2000,
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    defaultCommand: 'gemini',
    yoloFlags: '--yolo --skip-trust',
    supportsPlanMode: false,
    supportsCompletionNotification: true,
    launch: {
      buildCommand: (context) => {
        const command = buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.gemini, context.agentCommand, context);
        return context.task
          ? appendCommandArgs(command, shellQuoteForDisplay(context.task, context.shellTarget))
          : command;
      },
    },
    resume: {
      buildPlan: (context) => {
        if (isPlanCopilot(context)) {
          throw new Error(getUnsupportedCopilotModeMessage('gemini', 'plan'));
        }
        return {
          strategy: 'command',
          command: appendCommandArgs(
            context.agentCommand,
            `--resume ${shellQuoteForDisplay(context.sessionId, context.shellTarget)}`,
          ),
        };
      },
    },
    ready: {
      pattern: /⏵/,
      fallbackDelayMs: CLAUDE_READY_DELAY_MS,
      timeoutMs: AGENT_READY_TIMEOUT_MS,
      pollIntervalMs: AGENT_READY_POLL_INTERVAL_MS,
      promptHandlers: [
        {
          id: 'gemini-trust-folder',
          pattern: GEMINI_TRUST_PROMPT_PATTERN,
          once: true,
          blocksReadiness: true,
          handle: () => ({ kind: 'sendKeys', keys: '' }),
        },
      ],
    },
    sessionCapture: {
      statusCommand: '/stats',
      sessionIdPattern: /Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      readyDelayMs: 15000,
      captureDelayMs: 2000,
    },
  },
  sudocode: {
    id: 'sudocode',
    label: 'Sudo Code',
    defaultCommand: 'scode',
    yoloFlags: '--dangerously-skip-permissions',
    supportsPlanMode: false,
    supportsCompletionNotification: false,
    launch: {
      buildCommand: (context) => buildAgentBaseCommand(
        BUILT_IN_AGENT_DEFINITIONS.sudocode,
        context.agentCommand,
        context,
      ),
    },
    resume: {
      requiresSessionFile: true,
      waitForSlashCommandReady: 'sudocodeSessionResumed',
      buildPlan: (context) => {
        const resumeRef = context.sessionFile?.trim() || context.sessionId;
        return {
          strategy: 'replSlashCommand',
          command: buildAgentBaseCommand(BUILT_IN_AGENT_DEFINITIONS.sudocode, context.agentCommand, context),
          // Sudo Code parses /resume by taking the full remainder after the
          // command name, so paths with spaces must be sent raw. Shell-style
          // quotes would become part of the path.
          slashCommand: `/resume ${resumeRef}`,
        };
      },
    },
    ready: {
      pattern: /(?:^|\n)\s*❯\s*/m,
      fallbackDelayMs: CLAUDE_READY_DELAY_MS,
      timeoutMs: AGENT_READY_TIMEOUT_MS,
      pollIntervalMs: AGENT_READY_POLL_INTERVAL_MS,
      promptHandlers: [
        {
          id: 'sudocode-broad-directory',
          pattern: SUDOCODE_BROAD_DIRECTORY_PROMPT_PATTERN,
          once: true,
          blocksReadiness: false,
          handle: () => ({ kind: 'sendKeys', keys: 'y' }),
        },
      ],
    },
    sessionCapture: {
      statusCommand: '/status',
      sessionIdPattern: /Session\s+(session-\d+-\d+)\b/,
      sessionFilePattern: /Auto-save\s+(.+?\.jsonl)/,
      readyDelayMs: 8000,
      captureDelayMs: 1000,
    },
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    supportsPlanMode: false,
    supportsCompletionNotification: false,
    launch: {
      buildCommand: buildCustomLaunchCommand,
    },
  },
};

export const AGENT_DEFINITIONS: Readonly<Record<AgentType, AgentDefinition>> = BUILT_IN_AGENT_DEFINITIONS;

export const AGENT_LABELS: Record<AgentType, string> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.map(id => [id, BUILT_IN_AGENT_DEFINITIONS[id].label]),
) as Record<AgentType, string>;

export const DEFAULT_AGENT_COMMANDS: Record<string, string> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.flatMap((id) => {
    const command = BUILT_IN_AGENT_DEFINITIONS[id].defaultCommand;
    return command ? [[id, command]] : [];
  }),
);

/** Per-agent flag to enable full auto-approve (skip all permission prompts) */
export const AGENT_YOLO_FLAGS: Record<string, string> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.flatMap((id) => {
    const flags = BUILT_IN_AGENT_DEFINITIONS[id].yoloFlags;
    return flags ? [[id, flags]] : [];
  }),
);

export const AGENT_SESSION_CAPTURE: Partial<Record<string, SessionCaptureConfig>> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.flatMap((id) => {
    const config = BUILT_IN_AGENT_DEFINITIONS[id].sessionCapture;
    return config ? [[id, config]] : [];
  }),
);

export const AGENT_READY_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.flatMap((id) => {
    const pattern = BUILT_IN_AGENT_DEFINITIONS[id].ready?.pattern;
    return pattern ? [[id, pattern]] : [];
  }),
);

export const AGENT_COMPLETION_NOTIFICATIONS: Record<string, boolean> = Object.fromEntries(
  AGENT_DEFINITION_ORDER.map(id => [id, BUILT_IN_AGENT_DEFINITIONS[id].supportsCompletionNotification]),
);

export function getAgentDefinition(agentType: string): AgentDefinition {
  return BUILT_IN_AGENT_DEFINITIONS[agentType as AgentType] || BUILT_IN_AGENT_DEFINITIONS.custom;
}

export function getAgentDefaultCommand(agentType: string): string | undefined {
  return DEFAULT_AGENT_COMMANDS[agentType] || getAgentDefinition(agentType).defaultCommand;
}

export function getAgentReadyPromptHandlers(agentType: string): AgentPromptHandler[] {
  const definition = getAgentDefinition(agentType);
  if (!definition.ready) {
    return [];
  }
  return [
    ...GLOBAL_READY_PROMPT_HANDLERS,
    ...(definition.ready.promptHandlers || []),
  ];
}

export function agentSupportsCompletionNotification(agentType: string): boolean {
  return getAgentDefinition(agentType).supportsCompletionNotification;
}

export function agentSupportsCopilotMode(agentType: string, copilotMode: CopilotMode): boolean {
  if (copilotMode === 'normal') {
    return true;
  }
  return getAgentDefinition(agentType).supportsPlanMode;
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
 * Build the shell command to RESUME an existing agent session.
 * Returns null if the agent type doesn't support resume.
 */
export function buildAgentResumeCommand(
  agentType: string,
  agentCommand: string,
  sessionId: string,
  workdir?: string,
  options?: AgentCommandOptions,
): string | null {
  const plan = buildAgentResumePlan(agentType, agentCommand, sessionId, workdir, null, options);
  return plan?.strategy === 'command' ? plan.command : null;
}

/**
 * Build the shell command and optional in-REPL slash command needed to resume
 * an existing agent session.
 */
export function buildAgentResumePlan(
  agentType: string,
  agentCommand: string,
  sessionId: string,
  workdir?: string,
  sessionFile?: string | null,
  options?: AgentCommandOptions,
): AgentResumePlan | null {
  const definition = getAgentDefinition(agentType);
  return definition.resume?.buildPlan({
    agentCommand,
    sessionId,
    workdir,
    sessionFile,
    copilotMode: options?.copilotMode,
    shellTarget: options?.shellTarget,
  }) ?? null;
}

/** Build the shell command to launch an agent (matches bash CLI get_agent_command) */
export function buildAgentLaunchCommand(
  agentType: string,
  agentCommand: string,
  task?: string,
  sessionId?: string,
  options?: AgentCommandOptions,
): string {
  return getAgentDefinition(agentType).launch.buildCommand({
    agentType,
    agentCommand,
    task,
    sessionId,
    copilotMode: options?.copilotMode,
    shellTarget: options?.shellTarget,
  });
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
      // cmd.exe `"..."` — embedded double quotes are doubled. (`$` and backtick
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
