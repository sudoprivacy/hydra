import * as fs from 'fs';
import * as path from 'path';
import { exec } from './exec';
import { getHydraConfigPath, toCanonicalPath } from './path';
import { parseHydraDefaultAgent, type HydraDefaultAgentResolution } from './hydraGlobalConfig';
import { shellQuote } from './shell';
import type { AgentType } from './types';

export interface ProjectPolicyWorkerConfig {
  notifyCopilot?: boolean;
  allowTaskWorkers?: boolean;
}

export interface ProjectPolicyNotificationsConfig {
  hooks?: unknown[];
}

export interface ProjectPolicyConfig {
  defaultAgent?: AgentType;
  baseBranch?: string;
  worker?: ProjectPolicyWorkerConfig;
  notifications?: ProjectPolicyNotificationsConfig;
}

export type EffectiveConfigSource = 'cli' | 'project' | 'global' | 'fallback';

export interface EffectiveValue<T> {
  value: T;
  source: EffectiveConfigSource;
}

export interface EffectiveProjectConfig {
  defaultAgent: EffectiveValue<string>;
  baseBranch: EffectiveValue<string | null>;
  worker: {
    notifyCopilot: EffectiveValue<boolean>;
    allowTaskWorkers: EffectiveValue<boolean>;
  };
}

export interface ProjectPolicyIssue {
  code: string;
  message: string;
  path?: string;
  field?: string;
}

export interface ProjectPolicyTrustRequirement {
  field: string;
  reason: string;
  count: number;
  path: string;
}

export interface ProjectPolicyInspection {
  found: boolean;
  path: string | null;
  projectRoot: string | null;
  searchStart: string;
  searchStop: string;
  policy: ProjectPolicyConfig;
  blockers: ProjectPolicyIssue[];
  warnings: ProjectPolicyIssue[];
  requiresTrust: ProjectPolicyTrustRequirement[];
}

export interface ResolveEffectiveProjectConfigInput {
  anchorPath?: string;
  globalDefaultAgent: HydraDefaultAgentResolution;
  cliDefaultAgent?: string;
  cliBaseBranch?: string;
  cliNotifyCopilot?: boolean;
}

export interface ResolveEffectiveProjectConfigResult {
  projectPolicy: ProjectPolicyInspection;
  effective: EffectiveProjectConfig;
}

const PROJECT_POLICY_RELATIVE_PATH = path.join('.hydra', 'config.json');
const MAX_PROJECT_POLICY_BYTES = 128 * 1024;

export async function inspectProjectPolicy(anchorPath: string = process.cwd()): Promise<ProjectPolicyInspection> {
  const discovery = discoverProjectPolicy(anchorPath);
  const base: ProjectPolicyInspection = {
    found: false,
    path: null,
    projectRoot: null,
    searchStart: discovery.searchStart,
    searchStop: discovery.searchStop,
    policy: {},
    blockers: [],
    warnings: [],
    requiresTrust: [],
  };

  if (!discovery.policyPath) {
    return base;
  }

  const foundBase: ProjectPolicyInspection = {
    ...base,
    found: true,
    path: discovery.policyPath,
    projectRoot: path.dirname(path.dirname(discovery.policyPath)),
  };

  const parsed = readProjectPolicyFile(discovery.policyPath);
  const policy = parsed.policy ?? {};
  const requiresTrust = buildTrustRequirements(policy, discovery.policyPath);
  return {
    ...foundBase,
    policy,
    blockers: parsed.blockers,
    warnings: parsed.warnings,
    requiresTrust,
  };
}

export async function resolveEffectiveProjectConfig(
  input: ResolveEffectiveProjectConfigInput,
): Promise<ResolveEffectiveProjectConfigResult> {
  const projectPolicy = await inspectProjectPolicy(input.anchorPath);
  if (projectPolicy.blockers.length > 0) {
    throw new Error(`Project Hydra policy is invalid: ${projectPolicy.blockers[0].message}`);
  }

  const cliDefaultAgent = input.cliDefaultAgent?.trim();
  const projectDefaultAgent = projectPolicy.policy.defaultAgent;
  const defaultAgent = cliDefaultAgent
    ? { value: cliDefaultAgent, source: 'cli' as const }
    : projectDefaultAgent
      ? { value: projectDefaultAgent, source: 'project' as const }
      : {
          value: input.globalDefaultAgent.agent,
          source: input.globalDefaultAgent.source === 'configured' ? 'global' as const : 'fallback' as const,
        };

  const cliBaseBranch = normalizeNonEmptyString(input.cliBaseBranch);
  const projectBaseBranch = normalizeNonEmptyString(projectPolicy.policy.baseBranch);
  const baseBranch = cliBaseBranch
    ? { value: cliBaseBranch, source: 'cli' as const }
    : projectBaseBranch
      ? { value: projectBaseBranch, source: 'project' as const }
      : { value: null, source: 'fallback' as const };

  const projectNotifyCopilot = projectPolicy.policy.worker?.notifyCopilot;
  const notifyCopilot = input.cliNotifyCopilot !== undefined
    ? { value: input.cliNotifyCopilot, source: 'cli' as const }
    : typeof projectNotifyCopilot === 'boolean'
      ? { value: projectNotifyCopilot, source: 'project' as const }
      : { value: true, source: 'fallback' as const };

  const projectAllowTaskWorkers = projectPolicy.policy.worker?.allowTaskWorkers;
  const allowTaskWorkers = typeof projectAllowTaskWorkers === 'boolean'
    ? { value: projectAllowTaskWorkers, source: 'project' as const }
    : { value: true, source: 'fallback' as const };

  return {
    projectPolicy,
    effective: {
      defaultAgent,
      baseBranch,
      worker: {
        notifyCopilot,
        allowTaskWorkers,
      },
    },
  };
}

export async function validateProjectPolicyForRepo(
  inspection: ProjectPolicyInspection,
  repoRoot: string | null | undefined,
): Promise<ProjectPolicyIssue[]> {
  const issues: ProjectPolicyIssue[] = [];
  const baseBranch = normalizeNonEmptyString(inspection.policy.baseBranch);
  if (!baseBranch || !repoRoot) {
    return issues;
  }

  try {
    await exec(`git rev-parse --verify ${shellQuote(baseBranch)}`, { cwd: repoRoot });
  } catch {
    issues.push({
      code: 'base-branch-not-found',
      message: `Project policy baseBranch "${baseBranch}" was not found in repository`,
      path: inspection.path ?? undefined,
      field: 'baseBranch',
    });
  }
  return issues;
}

function discoverProjectPolicy(anchorPath: string): { searchStart: string; searchStop: string; policyPath: string | null } {
  let current = toCanonicalPath(anchorPath) || path.resolve(anchorPath);
  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  const searchStart = current;
  const gitRoot = findGitRoot(current);
  const searchStop = gitRoot ?? path.parse(current).root;
  const globalConfigPath = toCanonicalPath(getHydraConfigPath());

  while (true) {
    const candidate = path.join(current, PROJECT_POLICY_RELATIVE_PATH);
    const canonicalCandidate = toCanonicalPath(candidate);
    if (canonicalCandidate && canonicalCandidate !== globalConfigPath && fs.existsSync(candidate)) {
      return { searchStart, searchStop, policyPath: canonicalCandidate };
    }
    if (current === searchStop || current === path.dirname(current)) {
      break;
    }
    current = path.dirname(current);
  }

  return { searchStart, searchStop, policyPath: null };
}

function readProjectPolicyFile(filePath: string): {
  policy?: ProjectPolicyConfig;
  blockers: ProjectPolicyIssue[];
  warnings: ProjectPolicyIssue[];
} {
  const blockers: ProjectPolicyIssue[] = [];
  const warnings: ProjectPolicyIssue[] = [];

  let stat: fs.Stats;
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      return {
        blockers: [{
          code: 'policy-symlink',
          message: 'Project Hydra policy must be a regular file, not a symlink',
          path: filePath,
        }],
        warnings,
      };
    }
    stat = fs.statSync(filePath);
  } catch (error) {
    return {
      blockers: [{
        code: 'policy-unreadable',
        message: `Project Hydra policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
        path: filePath,
      }],
      warnings,
    };
  }

  if (!stat.isFile()) {
    return {
      blockers: [{
        code: 'policy-not-file',
        message: 'Project Hydra policy must be a regular file',
        path: filePath,
      }],
      warnings,
    };
  }
  if (stat.size > MAX_PROJECT_POLICY_BYTES) {
    return {
      blockers: [{
        code: 'policy-too-large',
        message: `Project Hydra policy exceeds ${MAX_PROJECT_POLICY_BYTES} bytes`,
        path: filePath,
      }],
      warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      blockers: [{
        code: 'policy-invalid-json',
        message: `Project Hydra policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path: filePath,
      }],
      warnings,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      blockers: [{
        code: 'policy-invalid-shape',
        message: 'Project Hydra policy must be a JSON object',
        path: filePath,
      }],
      warnings,
    };
  }

  const policy = parseProjectPolicyObject(parsed as Record<string, unknown>, filePath, blockers, warnings);
  return { policy, blockers, warnings };
}

function parseProjectPolicyObject(
  raw: Record<string, unknown>,
  filePath: string,
  blockers: ProjectPolicyIssue[],
  warnings: ProjectPolicyIssue[],
): ProjectPolicyConfig {
  const policy: ProjectPolicyConfig = {};
  warnUnknownKeys(raw, ['defaultAgent', 'baseBranch', 'worker', 'notifications'], filePath, '', warnings);

  if ('defaultAgent' in raw) {
    if (typeof raw.defaultAgent === 'string') {
      try {
        policy.defaultAgent = parseHydraDefaultAgent(raw.defaultAgent);
      } catch (error) {
        blockers.push({
          code: 'policy-invalid-agent',
          message: error instanceof Error ? error.message : String(error),
          path: filePath,
          field: 'defaultAgent',
        });
      }
    } else {
      blockers.push({
        code: 'policy-invalid-agent-type',
        message: 'Project policy defaultAgent must be a string',
        path: filePath,
        field: 'defaultAgent',
      });
    }
  }

  if ('baseBranch' in raw) {
    if (typeof raw.baseBranch === 'string' && raw.baseBranch.trim()) {
      policy.baseBranch = raw.baseBranch.trim();
    } else {
      blockers.push({
        code: 'policy-invalid-base-branch',
        message: 'Project policy baseBranch must be a non-empty string',
        path: filePath,
        field: 'baseBranch',
      });
    }
  }

  if ('worker' in raw) {
    if (isPlainObject(raw.worker)) {
      policy.worker = parseWorkerPolicy(raw.worker, filePath, blockers, warnings);
    } else {
      blockers.push({
        code: 'policy-invalid-worker',
        message: 'Project policy worker must be an object',
        path: filePath,
        field: 'worker',
      });
    }
  }

  if ('notifications' in raw) {
    if (isPlainObject(raw.notifications)) {
      policy.notifications = parseNotificationsPolicy(raw.notifications, filePath, blockers, warnings);
    } else {
      blockers.push({
        code: 'policy-invalid-notifications',
        message: 'Project policy notifications must be an object',
        path: filePath,
        field: 'notifications',
      });
    }
  }

  return policy;
}

function parseWorkerPolicy(
  raw: Record<string, unknown>,
  filePath: string,
  blockers: ProjectPolicyIssue[],
  warnings: ProjectPolicyIssue[],
): ProjectPolicyWorkerConfig {
  const worker: ProjectPolicyWorkerConfig = {};
  warnUnknownKeys(raw, ['notifyCopilot', 'allowTaskWorkers'], filePath, 'worker', warnings);
  if ('notifyCopilot' in raw) {
    if (typeof raw.notifyCopilot === 'boolean') {
      worker.notifyCopilot = raw.notifyCopilot;
    } else {
      blockers.push({
        code: 'policy-invalid-notify-copilot',
        message: 'Project policy worker.notifyCopilot must be a boolean',
        path: filePath,
        field: 'worker.notifyCopilot',
      });
    }
  }
  if ('allowTaskWorkers' in raw) {
    if (typeof raw.allowTaskWorkers === 'boolean') {
      worker.allowTaskWorkers = raw.allowTaskWorkers;
      warnings.push({
        code: 'policy-allow-task-workers-preview',
        message: 'Project policy worker.allowTaskWorkers is reported for diagnostics but is not enforced by this Hydra version',
        path: filePath,
        field: 'worker.allowTaskWorkers',
      });
    } else {
      blockers.push({
        code: 'policy-invalid-allow-task-workers',
        message: 'Project policy worker.allowTaskWorkers must be a boolean',
        path: filePath,
        field: 'worker.allowTaskWorkers',
      });
    }
  }
  return worker;
}

function parseNotificationsPolicy(
  raw: Record<string, unknown>,
  filePath: string,
  blockers: ProjectPolicyIssue[],
  warnings: ProjectPolicyIssue[],
): ProjectPolicyNotificationsConfig {
  const notifications: ProjectPolicyNotificationsConfig = {};
  warnUnknownKeys(raw, ['hooks'], filePath, 'notifications', warnings);
  if ('hooks' in raw) {
    if (Array.isArray(raw.hooks)) {
      notifications.hooks = raw.hooks;
      if (raw.hooks.length > 0) {
        warnings.push({
          code: 'policy-hooks-doctor-only',
          message: 'Project notification hooks are not executed by this Hydra version and require explicit trust before any future execution',
          path: filePath,
          field: 'notifications.hooks',
        });
      }
    } else {
      blockers.push({
        code: 'policy-invalid-notification-hooks',
        message: 'Project policy notifications.hooks must be an array',
        path: filePath,
        field: 'notifications.hooks',
      });
    }
  }
  return notifications;
}

function buildTrustRequirements(policy: ProjectPolicyConfig, filePath: string): ProjectPolicyTrustRequirement[] {
  const hookCount = policy.notifications?.hooks?.length ?? 0;
  if (hookCount === 0) {
    return [];
  }
  return [{
    field: 'notifications.hooks',
    reason: 'Project-defined executable notification hooks require explicit trust before execution',
    count: hookCount,
    path: filePath,
  }];
}

function warnUnknownKeys(
  raw: Record<string, unknown>,
  allowedKeys: readonly string[],
  filePath: string,
  parentField: string,
  warnings: ProjectPolicyIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) {
      continue;
    }
    const field = parentField ? `${parentField}.${key}` : key;
    warnings.push({
      code: 'policy-unknown-key',
      message: `Unknown project policy key "${field}" is ignored`,
      path: filePath,
      field,
    });
  }
}

function findGitRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
