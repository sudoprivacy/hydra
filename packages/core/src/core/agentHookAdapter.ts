import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getHydraHome } from './path';
import { shellQuote } from './shell';
import type { AgentType } from './types';

export type AgentSignalCapability =
  | 'complete'
  | 'needsInput'
  | 'inputResolved'
  | 'aborted'
  | 'runtimeError';

export type AgentSignalSupport = 'hook' | 'transcript' | 'unsupported';
export type AgentHookConfigScope = 'project' | 'global' | 'none';

export interface AgentHookCapabilities {
  complete: AgentSignalSupport;
  needsInput: AgentSignalSupport;
  inputResolved: AgentSignalSupport;
  aborted: AgentSignalSupport;
  runtimeError: AgentSignalSupport;
}

export interface AgentHookDiagnostic {
  agentType: string;
  adapter: AgentType;
  configScope: AgentHookConfigScope;
  capabilities: AgentHookCapabilities;
}

export interface AgentCompletionHookScript {
  path: string;
  content: string;
  mode?: number;
}

export interface AgentHookInstallRequest {
  agentType: string;
  workdir: string;
  sessionName: string;
  completion?: AgentCompletionHookScript;
}

export interface AgentHookRemoveRequest {
  agentType: string;
  workdir: string;
  sessionName: string;
  completionScriptPath?: string;
}

export interface AgentHookOperationResult {
  status: 'changed' | 'unchanged' | 'unsupported';
  diagnostic: AgentHookDiagnostic;
  configPaths: string[];
}

interface AgentHookAdapter {
  agentType: AgentType;
  configScope: AgentHookConfigScope;
  capabilities: AgentHookCapabilities;
  buildProjectPlan?: (request: AgentHookInstallRequest) => ProjectHookPlan;
}

interface HookRegistration {
  eventName: string;
  entry: Record<string, unknown>;
}

interface ProjectHookPlan {
  configPath: string;
  registrations: HookRegistration[];
}

interface ProjectEventReceipt {
  eventName: string;
  existed: boolean;
  entry: Record<string, unknown>;
}

interface ProjectHookReceipt {
  version: 1;
  kind: 'project-json';
  agentType: AgentType;
  sessionName: string;
  configPath: string;
  configExisted: boolean;
  hooksExisted: boolean;
  events: ProjectEventReceipt[];
}

interface GlobalHookReceipt {
  version: 1;
  kind: 'antigravity-global';
  agentType: 'antigravity';
  sessionName: string;
  configPath: string;
  configExisted: boolean;
  hookName: string;
  hookExisted: boolean;
  previousEntry?: unknown;
  entry: Record<string, unknown>;
}

type AgentHookReceipt = ProjectHookReceipt | GlobalHookReceipt;

interface JsonObjectFile {
  existed: boolean;
  value: Record<string, unknown>;
}

const AGENT_ORDER: AgentType[] = ['claude', 'codex', 'gemini', 'antigravity', 'sudocode', 'custom'];
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

const UNSUPPORTED_CAPABILITIES: AgentHookCapabilities = {
  complete: 'unsupported',
  needsInput: 'unsupported',
  inputResolved: 'unsupported',
  aborted: 'unsupported',
  runtimeError: 'unsupported',
};

const AGENT_HOOK_ADAPTERS: Record<AgentType, AgentHookAdapter> = {
  claude: {
    agentType: 'claude',
    configScope: 'project',
    capabilities: {
      complete: 'hook',
      needsInput: 'hook',
      inputResolved: 'unsupported',
      aborted: 'unsupported',
      runtimeError: 'unsupported',
    },
    buildProjectPlan: buildClaudeHookPlan,
  },
  codex: {
    agentType: 'codex',
    configScope: 'project',
    capabilities: {
      complete: 'hook',
      needsInput: 'transcript',
      inputResolved: 'transcript',
      aborted: 'transcript',
      runtimeError: 'unsupported',
    },
    buildProjectPlan: buildCodexHookPlan,
  },
  gemini: {
    agentType: 'gemini',
    configScope: 'project',
    capabilities: {
      complete: 'hook',
      needsInput: 'unsupported',
      inputResolved: 'unsupported',
      aborted: 'unsupported',
      runtimeError: 'unsupported',
    },
    buildProjectPlan: buildGeminiHookPlan,
  },
  antigravity: {
    agentType: 'antigravity',
    configScope: 'global',
    capabilities: {
      complete: 'hook',
      needsInput: 'unsupported',
      inputResolved: 'unsupported',
      aborted: 'unsupported',
      runtimeError: 'unsupported',
    },
  },
  sudocode: {
    agentType: 'sudocode',
    configScope: 'none',
    capabilities: UNSUPPORTED_CAPABILITIES,
  },
  custom: {
    agentType: 'custom',
    configScope: 'none',
    capabilities: UNSUPPORTED_CAPABILITIES,
  },
};

export function getAgentHookDiagnostic(agentType: string): AgentHookDiagnostic {
  const normalized = normalizeAgentType(agentType);
  const definition = AGENT_HOOK_ADAPTERS[normalized];
  return {
    agentType,
    adapter: definition.agentType,
    configScope: definition.configScope,
    capabilities: { ...definition.capabilities },
  };
}

export function listAgentHookDiagnostics(): AgentHookDiagnostic[] {
  return AGENT_ORDER.map(getAgentHookDiagnostic);
}

export function agentSupportsSignalCapability(
  agentType: string,
  capability: AgentSignalCapability,
): boolean {
  return getAgentHookDiagnostic(agentType).capabilities[capability] !== 'unsupported';
}

export function installAgentHooks(request: AgentHookInstallRequest): AgentHookOperationResult {
  const diagnostic = getAgentHookDiagnostic(request.agentType);
  if (diagnostic.configScope === 'none') {
    return { status: 'unsupported', diagnostic, configPaths: [] };
  }

  if (diagnostic.adapter === 'antigravity') {
    return installAntigravityHook(request, diagnostic);
  }

  const adapter = AGENT_HOOK_ADAPTERS[diagnostic.adapter];
  const plan = adapter.buildProjectPlan?.(request);
  if (!plan) {
    return { status: 'unsupported', diagnostic, configPaths: [] };
  }
  if (plan.registrations.length === 0) {
    return { status: 'unchanged', diagnostic, configPaths: [plan.configPath] };
  }
  const changed = installProjectHooks(request, plan.configPath, plan.registrations);
  return {
    status: changed ? 'changed' : 'unchanged',
    diagnostic,
    configPaths: [plan.configPath],
  };
}

export function removeAgentHooks(request: AgentHookRemoveRequest): AgentHookOperationResult {
  const diagnostic = getAgentHookDiagnostic(request.agentType);
  if (diagnostic.configScope === 'none') {
    return { status: 'unsupported', diagnostic, configPaths: [] };
  }

  const receiptPath = getAgentHookReceiptPath(request.sessionName, request.agentType);
  const receipt = readReceipt(receiptPath);
  let changed: boolean;
  let configPath: string;
  if (receipt) {
    assertReceiptIdentity(receipt, request.agentType, request.sessionName);
    configPath = receipt.configPath;
    changed = receipt.kind === 'project-json'
      ? removeProjectHooksFromReceipt(receipt)
      : removeAntigravityHookFromReceipt(receipt);
    fs.rmSync(receiptPath, { force: true });
  } else if (diagnostic.adapter === 'antigravity') {
    configPath = getAntigravityHooksPath();
    changed = removeLegacyAntigravityHook(configPath, request.sessionName);
  } else {
    const adapter = AGENT_HOOK_ADAPTERS[diagnostic.adapter];
    const plan = adapter.buildProjectPlan?.({
      ...request,
      completion: request.completionScriptPath
        ? { path: request.completionScriptPath, content: '' }
        : undefined,
    });
    if (!plan) {
      return { status: 'unsupported', diagnostic, configPaths: [] };
    }
    configPath = plan.configPath;
    changed = removeLegacyProjectHooks(configPath, plan.registrations);
  }

  return {
    status: changed ? 'changed' : 'unchanged',
    diagnostic,
    configPaths: [configPath],
  };
}

export function getAgentHookReceiptPath(sessionName: string, agentType: string): string {
  const digest = createHash('sha256')
    .update(`${normalizeAgentType(agentType)}\0${sessionName}`)
    .digest('hex')
    .slice(0, 20);
  return path.join(getHydraHome(), 'hooks', `agent-config-${digest}.json`);
}

export function buildAgentCompletionHookCommand(
  scriptPath: string,
  agentType: string,
  worktreePath?: string,
  platform: typeof process.platform = process.platform,
): string {
  if (platform === 'win32') {
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quoteWindowsCommandArg(scriptPath)}`;
    return agentType === 'codex' || agentType === 'gemini'
      ? `${command} >NUL & echo {}`
      : command;
  }

  const command = `sh ${shellQuote(scriptPath)}`;
  switch (agentType) {
    case 'codex':
    case 'gemini':
      return `${command} >/dev/null; printf '{}'`;
    case 'antigravity': {
      if (!worktreePath) {
        return `${command} >/dev/null; printf '{}'`;
      }
      const quotedWorkdir = shellQuote(worktreePath);
      return [
        'payload=$(cat 2>/dev/null || true)',
        `case "$payload" in *'"'${quotedWorkdir}'"'*) printf '%s' "$payload" | ${command} >/dev/null ;; esac`,
        `printf '{}'`,
      ].join('; ');
    }
    default:
      return command;
  }
}

function normalizeAgentType(agentType: string): AgentType {
  return Object.prototype.hasOwnProperty.call(AGENT_HOOK_ADAPTERS, agentType)
    ? agentType as AgentType
    : 'custom';
}

function buildClaudeHookPlan(request: AgentHookInstallRequest): ProjectHookPlan {
  const completionCommand = request.completion
    ? buildAgentCompletionHookCommand(request.completion.path, 'claude', request.workdir)
    : undefined;
  return {
    configPath: resolveConfigPath(path.join(request.workdir, '.claude', 'settings.json')),
    registrations: [
      ...(completionCommand ? [{
        eventName: 'Stop',
        entry: { hooks: [{ type: 'command', command: completionCommand, async: true }] },
      }] : []),
      {
        eventName: 'PermissionRequest',
        entry: { hooks: [{
          type: 'command',
          command: buildNeedsInputHookCommand(request.sessionName, 'claude', 'PermissionRequest'),
          async: true,
        }] },
      },
      {
        eventName: 'PreToolUse',
        entry: { hooks: [{
          type: 'command',
          command: buildNeedsInputHookCommand(request.sessionName, 'claude', 'PreToolUse'),
          async: true,
        }] },
      },
    ],
  };
}

function buildCodexHookPlan(request: AgentHookInstallRequest): ProjectHookPlan {
  const command = request.completion
    ? buildAgentCompletionHookCommand(request.completion.path, 'codex', request.workdir)
    : undefined;
  return {
    configPath: resolveConfigPath(path.join(request.workdir, '.codex', 'hooks.json')),
    registrations: command ? [{
      eventName: 'Stop',
      entry: { hooks: [{ type: 'command', command }] },
    }] : [],
  };
}

function buildGeminiHookPlan(request: AgentHookInstallRequest): ProjectHookPlan {
  const command = request.completion
    ? buildAgentCompletionHookCommand(request.completion.path, 'gemini', request.workdir)
    : undefined;
  return {
    configPath: resolveConfigPath(path.join(request.workdir, '.gemini', 'settings.json')),
    registrations: command ? [{
      eventName: 'AfterAgent',
      entry: {
        matcher: '*',
        hooks: [{
          name: 'hydra-notify-copilot',
          type: 'command',
          command,
          timeout: 5000,
        }],
      },
    }] : [],
  };
}

function installProjectHooks(
  request: AgentHookInstallRequest,
  configPath: string,
  registrations: HookRegistration[],
): boolean {
  const receiptPath = getAgentHookReceiptPath(request.sessionName, request.agentType);
  return withFileLock(configPath, () => {
    const configFile = readJsonObjectFile(configPath, 'Agent hook configuration');
    const config = configFile.value;
    const hooksExisted = Object.prototype.hasOwnProperty.call(config, 'hooks');
    const hooks = getHooksObject(config, configPath, true);
    if (!hooks) {
      throw new Error(`Agent hook configuration at ${configPath} could not initialize hooks`);
    }
    const existingReceipt = readReceipt(receiptPath);
    validateEventArrays(
      hooks,
      existingReceipt?.kind === 'project-json'
        ? [...registrations, ...existingReceipt.events]
        : registrations,
      configPath,
    );
    const receipt = prepareProjectReceipt(
      existingReceipt,
      request,
      configPath,
      configFile.existed,
      hooksExisted,
      hooks,
      registrations,
    );

    let configChanged = false;
    const registrationsChanged = existingReceipt?.kind === 'project-json'
      && JSON.stringify(existingReceipt.events.map(({ eventName, entry }) => ({ eventName, entry })))
        !== JSON.stringify(receipt.events.map(({ eventName, entry }) => ({ eventName, entry })));
    if (existingReceipt?.kind === 'project-json' && registrationsChanged) {
      configChanged = removeRegistrations(hooks, existingReceipt.events) || configChanged;
      const nextEvents = new Set(registrations.map(registration => registration.eventName));
      for (const previous of existingReceipt.events) {
        const entries = hooks[previous.eventName];
        if (!nextEvents.has(previous.eventName) && !previous.existed && Array.isArray(entries) && entries.length === 0) {
          delete hooks[previous.eventName];
          configChanged = true;
        }
      }
    }
    for (const registration of registrations) {
      let entries = hooks[registration.eventName] as unknown[] | undefined;
      if (!entries) {
        entries = [];
        hooks[registration.eventName] = entries;
        configChanged = true;
      }
      if (!entries.some(entry => hookEntriesMatch(entry, registration.entry))) {
        entries.push(clone(registration.entry));
        configChanged = true;
      }
    }

    const receiptChanged = !existingReceipt || JSON.stringify(existingReceipt) !== JSON.stringify(receipt);
    if (receiptChanged) {
      writeJsonAtomically(receiptPath, receipt);
    }
    const scriptChanged = request.completion
      ? writeTextIfChanged(
        request.completion.path,
        request.completion.content,
        request.completion.mode ?? 0o755,
      )
      : false;
    if (configChanged) {
      writeJsonAtomically(configPath, config);
    }
    return receiptChanged || scriptChanged || configChanged;
  });
}

function prepareProjectReceipt(
  existing: AgentHookReceipt | undefined,
  request: AgentHookInstallRequest,
  configPath: string,
  configExisted: boolean,
  hooksExisted: boolean,
  hooks: Record<string, unknown>,
  registrations: HookRegistration[],
): ProjectHookReceipt {
  if (existing) {
    assertReceiptIdentity(existing, request.agentType, request.sessionName);
    if (existing.kind !== 'project-json' || existing.configPath !== configPath) {
      throw new Error(`Agent hook receipt for ${request.sessionName} does not match ${configPath}`);
    }
  }
  const priorEvents = existing?.kind === 'project-json'
    ? new Map(existing.events.map(event => [event.eventName, event]))
    : new Map<string, ProjectEventReceipt>();
  return {
    version: 1,
    kind: 'project-json',
    agentType: normalizeAgentType(request.agentType),
    sessionName: request.sessionName,
    configPath,
    configExisted: existing?.kind === 'project-json' ? existing.configExisted : configExisted,
    hooksExisted: existing?.kind === 'project-json' ? existing.hooksExisted : hooksExisted,
    events: registrations.map(registration => ({
      eventName: registration.eventName,
      existed: priorEvents.get(registration.eventName)?.existed
        ?? Object.prototype.hasOwnProperty.call(hooks, registration.eventName),
      entry: clone(registration.entry),
    })),
  };
}

function installAntigravityHook(
  request: AgentHookInstallRequest,
  diagnostic: AgentHookDiagnostic,
): AgentHookOperationResult {
  const configPath = resolveConfigPath(getAntigravityHooksPath());
  if (!request.completion) {
    return { status: 'unchanged', diagnostic, configPaths: [configPath] };
  }
  const hookName = `hydra-notify-${request.sessionName}`;
  const hookCommand = buildAgentCompletionHookCommand(
    request.completion.path,
    'antigravity',
    request.workdir,
  );
  const entry = {
    PreInvocation: null,
    PostInvocation: null,
    Stop: [{ type: 'command', command: hookCommand, timeout: 0 }],
    PreToolUse: null,
    PostToolUse: null,
  };
  const receiptPath = getAgentHookReceiptPath(request.sessionName, request.agentType);
  const changed = withFileLock(configPath, () => {
    const configFile = readJsonObjectFile(configPath, 'Antigravity hook configuration');
    const existingReceipt = readReceipt(receiptPath);
    if (existingReceipt) {
      assertReceiptIdentity(existingReceipt, request.agentType, request.sessionName);
      if (existingReceipt.kind !== 'antigravity-global' || existingReceipt.configPath !== configPath) {
        throw new Error(`Agent hook receipt for ${request.sessionName} does not match ${configPath}`);
      }
      const currentEntry = configFile.value[hookName];
      if (currentEntry !== undefined && !hookEntriesMatch(currentEntry, existingReceipt.entry)) {
        throw new Error(`Antigravity hook ${hookName} changed after Hydra installed it`);
      }
    }
    const receipt: GlobalHookReceipt = {
      version: 1,
      kind: 'antigravity-global',
      agentType: 'antigravity',
      sessionName: request.sessionName,
      configPath,
      configExisted: existingReceipt?.kind === 'antigravity-global'
        ? existingReceipt.configExisted
        : configFile.existed,
      hookName,
      hookExisted: existingReceipt?.kind === 'antigravity-global'
        ? existingReceipt.hookExisted
        : Object.prototype.hasOwnProperty.call(configFile.value, hookName),
      previousEntry: existingReceipt?.kind === 'antigravity-global'
        ? existingReceipt.previousEntry
        : clone(configFile.value[hookName]),
      entry,
    };
    const receiptChanged = !existingReceipt || JSON.stringify(existingReceipt) !== JSON.stringify(receipt);
    if (receiptChanged) {
      writeJsonAtomically(receiptPath, receipt);
    }
    const scriptChanged = writeTextIfChanged(
      request.completion!.path,
      request.completion!.content,
      request.completion!.mode ?? 0o755,
    );
    const configChanged = !hookEntriesMatch(configFile.value[hookName], entry);
    if (configChanged) {
      configFile.value[hookName] = clone(entry);
      writeJsonAtomically(configPath, configFile.value);
    }
    return receiptChanged || scriptChanged || configChanged;
  });
  return {
    status: changed ? 'changed' : 'unchanged',
    diagnostic,
    configPaths: [configPath],
  };
}

function removeProjectHooksFromReceipt(receipt: ProjectHookReceipt): boolean {
  if (!fs.existsSync(receipt.configPath)) return false;
  return withFileLock(receipt.configPath, () => {
    const configFile = readJsonObjectFile(receipt.configPath, 'Agent hook configuration');
    const config = configFile.value;
    const hooks = getHooksObject(config, receipt.configPath, false);
    if (!hooks) return false;
    validateEventArrays(hooks, receipt.events, receipt.configPath);
    let changed = removeRegistrations(hooks, receipt.events);

    for (const event of receipt.events) {
      const entries = hooks[event.eventName];
      if (!event.existed && Array.isArray(entries) && entries.length === 0) {
        delete hooks[event.eventName];
        changed = true;
      }
    }
    if (!receipt.hooksExisted && Object.keys(hooks).length === 0) {
      delete config.hooks;
      changed = true;
    }
    if (!changed) return false;
    if (!receipt.configExisted && Object.keys(config).length === 0) {
      fs.rmSync(receipt.configPath, { force: true });
    } else {
      writeJsonAtomically(receipt.configPath, config);
    }
    return true;
  });
}

function removeAntigravityHookFromReceipt(receipt: GlobalHookReceipt): boolean {
  if (!fs.existsSync(receipt.configPath)) return false;
  return withFileLock(receipt.configPath, () => {
    const configFile = readJsonObjectFile(receipt.configPath, 'Antigravity hook configuration');
    if (!Object.prototype.hasOwnProperty.call(configFile.value, receipt.hookName)) return false;
    if (!hookEntriesMatch(configFile.value[receipt.hookName], receipt.entry)) {
      throw new Error(`Antigravity hook ${receipt.hookName} changed after Hydra installed it`);
    }
    if (receipt.hookExisted) {
      configFile.value[receipt.hookName] = clone(receipt.previousEntry);
    } else {
      delete configFile.value[receipt.hookName];
    }
    if (!receipt.configExisted && Object.keys(configFile.value).length === 0) {
      fs.rmSync(receipt.configPath, { force: true });
    } else {
      writeJsonAtomically(receipt.configPath, configFile.value);
    }
    return true;
  });
}

function removeLegacyProjectHooks(configPath: string, registrations: HookRegistration[]): boolean {
  if (!fs.existsSync(configPath) || registrations.length === 0) return false;
  return withFileLock(configPath, () => {
    const configFile = readJsonObjectFile(configPath, 'Agent hook configuration');
    const hooks = getHooksObject(configFile.value, configPath, false);
    if (!hooks) return false;
    validateEventArrays(hooks, registrations, configPath);
    const changed = removeRegistrations(hooks, registrations);
    if (changed) writeJsonAtomically(configPath, configFile.value);
    return changed;
  });
}

function removeLegacyAntigravityHook(configPath: string, sessionName: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  return withFileLock(configPath, () => {
    const configFile = readJsonObjectFile(configPath, 'Antigravity hook configuration');
    const hookName = `hydra-notify-${sessionName}`;
    if (!Object.prototype.hasOwnProperty.call(configFile.value, hookName)) return false;
    delete configFile.value[hookName];
    writeJsonAtomically(configPath, configFile.value);
    return true;
  });
}

function getHooksObject(
  config: Record<string, unknown>,
  configPath: string,
  create: boolean,
): Record<string, unknown> | undefined {
  const hooks = config.hooks;
  if (hooks === undefined) {
    if (!create) return undefined;
    const next: Record<string, unknown> = {};
    config.hooks = next;
    return next;
  }
  if (!isRecord(hooks)) {
    throw new Error(`Agent hook configuration at ${configPath} has a non-object hooks field`);
  }
  return hooks;
}

function validateEventArrays(
  hooks: Record<string, unknown>,
  registrations: Array<Pick<HookRegistration, 'eventName'>>,
  configPath: string,
): void {
  for (const registration of registrations) {
    const value = hooks[registration.eventName];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(
        `Agent hook configuration at ${configPath} has a non-array ${registration.eventName} hook`,
      );
    }
  }
}

function removeRegistrations(
  hooks: Record<string, unknown>,
  registrations: Array<Pick<HookRegistration, 'eventName' | 'entry'>>,
): boolean {
  let changed = false;
  for (const registration of registrations) {
    const entries = hooks[registration.eventName];
    if (!Array.isArray(entries)) continue;
    const remaining = entries.filter(entry => !hookEntriesMatch(entry, registration.entry));
    if (remaining.length !== entries.length) {
      hooks[registration.eventName] = remaining;
      changed = true;
    }
  }
  return changed;
}

function hookEntriesMatch(left: unknown, right: unknown): boolean {
  const leftCommand = extractFirstHookCommand(left);
  const rightCommand = extractFirstHookCommand(right);
  if (leftCommand && rightCommand) return leftCommand === rightCommand;
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractFirstHookCommand(entry: unknown): string | undefined {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) return undefined;
  for (const hook of entry.hooks) {
    if (isRecord(hook) && typeof hook.command === 'string' && hook.command.trim()) {
      return hook.command;
    }
  }
  return undefined;
}

function buildNeedsInputHookCommand(sessionName: string, agentType: string, eventName: string): string {
  if (process.platform === 'win32') {
    const psq = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return [
      '$hydra = Get-Command hydra -ErrorAction SilentlyContinue',
      '$hydraPath = if ($hydra) { $hydra.Source } else { $null }',
      'if (-not $hydraPath) {',
      "  foreach ($candidate in @((Join-Path $HOME '.hydra\\bin\\hydra.cmd'), (Join-Path $HOME '.hydra\\bin\\hydra.ps1'), (Join-Path $HOME '.hydra\\bin\\hydra'))) {",
      '    if (Test-Path -LiteralPath $candidate) { $hydraPath = $candidate; break }',
      '  }',
      '}',
      `if ($hydraPath) { & $hydraPath hooks needs-input --agent ${psq(agentType)} --session ${psq(sessionName)} --event ${psq(eventName)} --json *> $null }`,
      'exit 0',
    ].join('; ');
  }
  const agent = shellQuote(agentType);
  const session = shellQuote(sessionName);
  const event = shellQuote(eventName);
  return [
    'HYDRA_CLI=$(command -v hydra 2>/dev/null || true)',
    '[ -n "$HYDRA_CLI" ] || HYDRA_CLI="$HOME/.hydra/bin/hydra"',
    `[ -x "$HYDRA_CLI" ] && "$HYDRA_CLI" hooks needs-input --agent ${agent} --session ${session} --event ${event} --json >/dev/null 2>&1 || true`,
  ].join('; ');
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function readJsonObjectFile(filePath: string, label: string): JsonObjectFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { existed: false, value: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} at ${filePath} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} at ${filePath} must contain a JSON object`);
  }
  return { existed: true, value: clone(parsed) };
}

function readReceipt(receiptPath: string): AgentHookReceipt | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(receiptPath, 'utf-8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Agent hook receipt at ${receiptPath} is not valid JSON`, { cause: error });
  }
  if (!isAgentHookReceipt(parsed)) {
    throw new Error(`Agent hook receipt at ${receiptPath} has invalid shape`);
  }
  return clone(parsed);
}

function isAgentHookReceipt(value: unknown): value is AgentHookReceipt {
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionName !== 'string') return false;
  if (typeof value.configPath !== 'string' || typeof value.configExisted !== 'boolean') return false;
  if (value.kind === 'project-json') {
    return typeof value.agentType === 'string'
      && typeof value.hooksExisted === 'boolean'
      && Array.isArray(value.events)
      && value.events.every(event => isRecord(event)
        && typeof event.eventName === 'string'
        && typeof event.existed === 'boolean'
        && isRecord(event.entry));
  }
  return value.kind === 'antigravity-global'
    && value.agentType === 'antigravity'
    && typeof value.hookName === 'string'
    && typeof value.hookExisted === 'boolean'
    && isRecord(value.entry);
}

function assertReceiptIdentity(receipt: AgentHookReceipt, agentType: string, sessionName: string): void {
  if (receipt.agentType !== normalizeAgentType(agentType) || receipt.sessionName !== sessionName) {
    throw new Error(`Agent hook receipt identity does not match ${agentType}/${sessionName}`);
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

function writeTextIfChanged(filePath: string, content: string, mode: number): boolean {
  try {
    if (fs.readFileSync(filePath, 'utf-8') === content) {
      if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  writeTextAtomically(filePath, content, mode);
  return true;
}

function writeTextAtomically(filePath: string, content: string, defaultMode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const mode = existingFileMode(filePath) ?? defaultMode;
  const tmpPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
    fs.renameSync(tmpPath, filePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function existingFileMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function resolveConfigPath(filePath: string): string {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isSymbolicLink()) return filePath;
    try {
      return fs.realpathSync(filePath);
    } catch (error) {
      throw new Error(`Agent hook configuration symlink at ${filePath} cannot be resolved`, { cause: error });
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return filePath;
    throw error;
  }
}

function getAntigravityHooksPath(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'hooks.json');
}

function withFileLock<T>(filePath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockDir = `${filePath}.hydra-lock`;
  const ownerPath = path.join(lockDir, randomUUID());
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(ownerPath, String(process.pid), 'utf-8');
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      removeStaleLock(lockDir);
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for agent hook configuration lock at ${lockDir}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fs.existsSync(ownerPath)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

function removeStaleLock(lockDir: string): void {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // The lock disappeared between checks.
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
