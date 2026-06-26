import * as fs from 'fs';
import {
  agentSupportsCopilotMode,
  buildAgentResumePlan,
  getAgentDefaultCommand,
  getAgentDefinition,
  type AgentCommandOptions,
} from './agentConfig';
import type { AgentSessionIndexEntry } from './agentSessionIndex';
import { getHydraConfig } from './path';
import type { CopilotMode } from './types';
import { validateBranchName } from './git';

export type ResumeDiagnosticOperation = 'start-active' | 'restore-archive' | 'none';
export type ResumeDiagnosticOutcome =
  | 'already-running'
  | 'resume'
  | 'fresh-start'
  | 'restore-will-attempt-resume'
  | 'blocked';
export type ResumeDiagnosticStrategy = 'command' | 'replSlashCommand' | null;
export type ResumeDiagnosticCommandKind = 'command' | 'replSlashCommand' | 'none';

export interface ResumeDiagnosticNote {
  code: string;
  message: string;
}

export interface ResumePlanDiagnostics {
  valid: boolean;
  strategy: ResumeDiagnosticStrategy;
  requiresSessionFile: boolean;
  hasSessionId: boolean;
  hasResolvedSessionFile: boolean;
  commandKind: ResumeDiagnosticCommandKind;
  reason: string | null;
}

export interface ResumeDiagnosticEvidence {
  agentSupportsResume: boolean;
  diagnosticsShellTarget: 'posix';
  commandPreviewExposed: false;
  source: AgentSessionIndexEntry['source'];
  role: AgentSessionIndexEntry['role'];
  status: AgentSessionIndexEntry['status'];
  agent: string;
  hasSessionId: boolean;
  hasStoredAgentSessionFile: boolean;
  storedAgentSessionFileExists: boolean;
  hasResolvedAgentSessionFile: boolean;
  agentSessionFileExists: boolean;
  workdirExists: boolean | null;
  workerType?: 'code' | 'task';
  workerSource?: 'repo' | 'directory';
  managedWorkdir?: boolean;
  hasRepoRoot?: boolean;
  repoRootExists?: boolean | null;
  hasBranch?: boolean;
  branchValidation?: string | null;
  copilotMode?: string;
}

export interface ResumeDiagnostics {
  schemaVersion: 1;
  operation: ResumeDiagnosticOperation;
  outcome: ResumeDiagnosticOutcome;
  resumePlan: ResumePlanDiagnostics;
  blockers: ResumeDiagnosticNote[];
  warnings: ResumeDiagnosticNote[];
  evidence: ResumeDiagnosticEvidence;
}

interface EvaluatedResumePlan {
  resumePlan: ResumePlanDiagnostics;
  warning: ResumeDiagnosticNote | null;
}

export function diagnoseAgentSessionResume(entry: AgentSessionIndexEntry): ResumeDiagnostics {
  const blockers = getOperationBlockers(entry);
  const warnings = getOperationWarnings(entry);
  const evaluated = evaluateResumePlan(entry);
  if (evaluated.warning) {
    warnings.push(evaluated.warning);
  }
  addResumePlanWarnings(entry, evaluated.resumePlan, warnings);

  const operation = getOperation(entry);
  const outcome = getOutcome(entry, operation, blockers, evaluated.resumePlan);

  return {
    schemaVersion: 1,
    operation,
    outcome,
    resumePlan: evaluated.resumePlan,
    blockers,
    warnings,
    evidence: getEvidence(entry),
  };
}

function getOperation(entry: AgentSessionIndexEntry): ResumeDiagnosticOperation {
  if (entry.source === 'archive') {
    return 'restore-archive';
  }
  if (entry.status === 'running') {
    return 'none';
  }
  return 'start-active';
}

function getOutcome(
  entry: AgentSessionIndexEntry,
  operation: ResumeDiagnosticOperation,
  blockers: ResumeDiagnosticNote[],
  resumePlan: ResumePlanDiagnostics,
): ResumeDiagnosticOutcome {
  if (blockers.length > 0) {
    return 'blocked';
  }
  if (operation === 'none') {
    return 'already-running';
  }
  if (operation === 'restore-archive') {
    return resumePlan.hasSessionId ? 'restore-will-attempt-resume' : 'fresh-start';
  }
  return resumePlan.valid ? 'resume' : 'fresh-start';
}

function evaluateResumePlan(entry: AgentSessionIndexEntry): EvaluatedResumePlan {
  const definition = getAgentDefinition(entry.agent);
  const requiresSessionFile = definition.resume?.requiresSessionFile === true;
  const hasSessionId = hasValue(entry.agentSessionId);
  const hasResolvedSessionFile = hasValue(entry.resolvedAgentSessionFile) && entry.agentSessionFileExists;
  const base: ResumePlanDiagnostics = {
    valid: false,
    strategy: null,
    requiresSessionFile,
    hasSessionId,
    hasResolvedSessionFile,
    commandKind: 'none',
    reason: null,
  };

  if (!definition.resume) {
    return {
      resumePlan: {
        ...base,
        reason: `Agent "${entry.agent}" does not support native session resume.`,
      },
      warning: null,
    };
  }
  if (!hasSessionId) {
    return {
      resumePlan: {
        ...base,
        reason: 'No stored native agent session id.',
      },
      warning: null,
    };
  }
  if (requiresSessionFile && !hasResolvedSessionFile) {
    const plan = buildPlanBestEffort(entry);
    return {
      resumePlan: {
        ...base,
        strategy: plan.strategy,
        commandKind: plan.commandKind,
        reason: 'Agent resume requires an existing native session file.',
      },
      warning: plan.warning,
    };
  }

  const plan = buildPlanBestEffort(entry);
  if (plan.error) {
    return {
      resumePlan: {
        ...base,
        reason: plan.error,
      },
      warning: plan.warning,
    };
  }
  if (!plan.strategy) {
    return {
      resumePlan: {
        ...base,
        reason: `Agent "${entry.agent}" does not support native session resume.`,
      },
      warning: null,
    };
  }

  return {
    resumePlan: {
      ...base,
      valid: true,
      strategy: plan.strategy,
      commandKind: plan.commandKind,
      reason: null,
    },
    warning: plan.warning,
  };
}

function buildPlanBestEffort(entry: AgentSessionIndexEntry): {
  strategy: ResumeDiagnosticStrategy;
  commandKind: ResumeDiagnosticCommandKind;
  error: string | null;
  warning: ResumeDiagnosticNote | null;
} {
  if (!entry.agentSessionId) {
    return { strategy: null, commandKind: 'none', error: null, warning: null };
  }

  try {
    const plan = buildAgentResumePlan(
      entry.agent,
      getConfiguredAgentCommand(entry.agent),
      entry.agentSessionId,
      entry.workdir ?? undefined,
      entry.resolvedAgentSessionFile,
      getPlanOptions(entry),
    );
    return {
      strategy: plan?.strategy ?? null,
      commandKind: plan?.strategy ?? 'none',
      error: null,
      warning: null,
    };
  } catch (error) {
    return {
      strategy: null,
      commandKind: 'none',
      error: error instanceof Error ? error.message : String(error),
      warning: isPlanCopilot(entry)
        ? {
            code: 'copilot-mode-plan-resume-check',
            message: 'Diagnostics evaluates the copilot-mode resume plan; older start logic may only fail when the resume launch is attempted.',
          }
        : null,
    };
  }
}

function getConfiguredAgentCommand(agent: string): string {
  return getHydraConfig().agentCommands?.[agent] || getAgentDefaultCommand(agent) || agent;
}

function getPlanOptions(entry: AgentSessionIndexEntry): AgentCommandOptions {
  return {
    shellTarget: 'posix',
    ...(isPlanCopilot(entry) ? { copilotMode: 'plan' as CopilotMode } : {}),
  };
}

function getOperationBlockers(entry: AgentSessionIndexEntry): ResumeDiagnosticNote[] {
  const blockers: ResumeDiagnosticNote[] = [];

  if (entry.source === 'active' && entry.status === 'running') {
    return blockers;
  }

  if (entry.source === 'active') {
    if (entry.status === 'stopped' && entry.role === 'worker' && !workdirExists(entry)) {
      blockers.push({
        code: 'missing-workdir',
        message: 'Active worker start requires the saved workdir to exist.',
      });
    }
    if (entry.status === 'stopped' && entry.role === 'copilot' && !workdirExists(entry)) {
      blockers.push({
        code: 'missing-workdir',
        message: 'Active copilot start requires the saved workdir to exist.',
      });
    }
    addUnsupportedCopilotModeBlocker(entry, blockers);
    return blockers;
  }

  if (entry.role === 'worker') {
    if (!entry.worker) {
      blockers.push({
        code: 'missing-worker-metadata',
        message: 'Archived worker restore requires worker metadata.',
      });
      return blockers;
    }
    if (entry.worker.type === 'code') {
      if (!hasValue(entry.worker.repoRoot) || !hasValue(entry.worker.branch)) {
        blockers.push({
          code: 'missing-repository-metadata',
          message: 'Archived code worker restore requires repoRoot and branch metadata.',
        });
      } else {
        const branchValidation = validateBranchName(entry.worker.branch);
        if (branchValidation) {
          blockers.push({
            code: 'invalid-branch-name',
            message: `Archived code worker restore would fail branch validation: ${branchValidation}`,
          });
        }
        if (!safeExists(entry.worker.repoRoot)) {
          blockers.push({
            code: 'repo-root-missing-on-disk',
            message: 'Archived code worker restore requires the saved repoRoot to exist on disk.',
          });
        }
      }
    } else {
      if (!hasValue(entry.workdir)) {
        blockers.push({
          code: 'missing-workdir',
          message: 'Archived task worker restore requires a saved workdir.',
        });
      } else if (!entry.worker.managedWorkdir && !safeExists(entry.workdir)) {
        blockers.push({
          code: 'missing-user-task-workdir',
          message: 'Archived task worker uses a user-provided workdir that no longer exists.',
        });
      }
    }
  } else {
    if (!hasValue(entry.workdir)) {
      blockers.push({
        code: 'missing-workdir',
        message: 'Archived copilot restore requires a saved workdir.',
      });
    } else if (!safeExists(entry.workdir)) {
      blockers.push({
        code: 'copilot-workdir-missing-on-disk',
        message: 'Archived copilot restore requires the saved workdir to exist on disk.',
      });
    }
    addUnsupportedCopilotModeBlocker(entry, blockers);
  }

  return blockers;
}

function getOperationWarnings(entry: AgentSessionIndexEntry): ResumeDiagnosticNote[] {
  const warnings: ResumeDiagnosticNote[] = [];

  if (entry.source === 'archive' && entry.worker?.type === 'task' && entry.worker.managedWorkdir && !safeExists(entry.workdir)) {
    warnings.push({
      code: 'managed-task-workdir-missing',
      message: 'Hydra-managed task workdir is missing; restore can recreate the folder.',
    });
  }

  return warnings;
}

function addUnsupportedCopilotModeBlocker(
  entry: AgentSessionIndexEntry,
  blockers: ResumeDiagnosticNote[],
): void {
  if (
    entry.role === 'copilot' &&
    entry.copilot?.mode === 'plan' &&
    !agentSupportsCopilotMode(entry.agent, 'plan')
  ) {
    blockers.push({
      code: 'unsupported-copilot-mode',
      message: `Agent "${entry.agent}" does not support planner mode.`,
    });
  }
}

function addResumePlanWarnings(
  entry: AgentSessionIndexEntry,
  resumePlan: ResumePlanDiagnostics,
  warnings: ResumeDiagnosticNote[],
): void {
  if (entry.status === 'running') {
    warnings.push({
      code: 'already-running',
      message: 'The session is already running; no resume command is needed.',
    });
  }

  if (resumePlan.requiresSessionFile && !resumePlan.hasResolvedSessionFile) {
    warnings.push({
      code: 'missing-required-session-file',
      message: entry.source === 'archive'
        ? 'Archive restore will pass the stored session id to the create path, but active resume checks would reject this plan without a session file.'
        : 'Active start will use a fresh agent launch because this agent requires an existing native session file.',
    });
  }
}

function getEvidence(entry: AgentSessionIndexEntry): ResumeDiagnosticEvidence {
  const evidence: ResumeDiagnosticEvidence = {
    agentSupportsResume: getAgentDefinition(entry.agent).resume != null,
    diagnosticsShellTarget: 'posix',
    commandPreviewExposed: false,
    source: entry.source,
    role: entry.role,
    status: entry.status,
    agent: entry.agent,
    hasSessionId: hasValue(entry.agentSessionId),
    hasStoredAgentSessionFile: hasValue(entry.storedAgentSessionFile),
    storedAgentSessionFileExists: entry.storedAgentSessionFileExists,
    hasResolvedAgentSessionFile: hasValue(entry.resolvedAgentSessionFile),
    agentSessionFileExists: entry.agentSessionFileExists,
    workdirExists: hasValue(entry.workdir) ? safeExists(entry.workdir) : null,
  };

  if (entry.worker) {
    evidence.workerType = entry.worker.type;
    evidence.workerSource = entry.worker.source;
    evidence.managedWorkdir = entry.worker.managedWorkdir;
    evidence.hasRepoRoot = hasValue(entry.worker.repoRoot);
    evidence.repoRootExists = hasValue(entry.worker.repoRoot) ? safeExists(entry.worker.repoRoot) : null;
    evidence.hasBranch = hasValue(entry.worker.branch);
    evidence.branchValidation = entry.worker.branch ? validateBranchName(entry.worker.branch) ?? null : null;
  }

  if (entry.copilot) {
    evidence.copilotMode = entry.copilot.mode;
  }

  return evidence;
}

function isPlanCopilot(entry: AgentSessionIndexEntry): boolean {
  return entry.role === 'copilot' && entry.copilot?.mode === 'plan';
}

function hasValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function workdirExists(entry: AgentSessionIndexEntry): boolean {
  return hasValue(entry.workdir) && safeExists(entry.workdir);
}

function safeExists(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
