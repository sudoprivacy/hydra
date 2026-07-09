import * as os from 'os';
import * as vscode from 'vscode';
import { getActiveBackend, MultiplexerBackend } from '../utils/multiplexer';
import { getAgentCommand, pickAgentType, AgentType, AGENT_LABELS } from '../utils/agentConfig';
import { CopilotMode } from '@hydra/core/types';
import { getCopilotOnboardingPrompt } from '@hydra/core/copilotOnboarding';
import { TmuxBackendCore } from '@hydra/core/tmux';
import { SessionManager } from '@hydra/core/sessionManager';
import { ensureBackendInstalled } from './ensureBackendInstalled';
import { showHydraCommandError } from './logs';

export function sendCopilotOnboarding(backend: MultiplexerBackend, sessionName: string, copilotMode: CopilotMode): void {
  (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await backend.sendMessage(sessionName, getCopilotOnboardingPrompt(copilotMode));
    } catch {
      // Best-effort — agent may not be ready yet
    }
  })();
}

function getDefaultSessionName(agentType: AgentType, copilotMode: CopilotMode): string {
  return copilotMode === 'plan' ? `hydra-plan-${agentType}` : `hydra-copilot-${agentType}`;
}

function getCreatedMessage(sessionName: string, agentType: AgentType, copilotMode: CopilotMode): string {
  if (copilotMode === 'plan') {
    const strategy = agentType === 'claude' ? 'native planner' : 'read-only planner';
    return `Planner created: ${sessionName} (${AGENT_LABELS[agentType]}, ${strategy})`;
  }
  return `Copilot created: ${sessionName} (${agentType})`;
}

function agentSupportsPlanner(agentType: AgentType): boolean {
  return agentType === 'claude' || agentType === 'codex';
}

async function pickModeForAgent(agentType: AgentType): Promise<CopilotMode | undefined> {
  if (!agentSupportsPlanner(agentType)) {
    return 'normal';
  }

  const plannerDescription = agentType === 'claude'
    ? 'Native planner; cannot create workers'
    : 'Read-only planner; cannot create workers';
  const picked = await vscode.window.showQuickPick([
    {
      label: 'Copilot',
      description: 'Can create workers and drive implementation',
      value: 'normal' as CopilotMode,
    },
    {
      label: 'Planner',
      description: plannerDescription,
      value: 'plan' as CopilotMode,
    },
  ], {
    placeHolder: `Select ${AGENT_LABELS[agentType]} mode`,
  });
  return picked?.value;
}

async function pickPlannerAgentType(): Promise<AgentType | undefined> {
  const items = [
    { label: AGENT_LABELS.claude, description: 'Native planner', value: 'claude' as AgentType },
    { label: AGENT_LABELS.codex, description: 'Read-only guarded planner', value: 'codex' as AgentType },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select agent for planner',
  });
  return picked?.value;
}

export async function createCopilotWithAgent(agentType: AgentType, copilotMode?: CopilotMode): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  const resolvedMode = copilotMode ?? await pickModeForAgent(agentType);
  if (!resolvedMode) return;

  const sessionName = backend.sanitizeSessionName(getDefaultSessionName(agentType, resolvedMode));

  // If session already exists, just attach
  if (await backend.hasSession(sessionName)) {
    const workdir = await backend.getSessionWorkdir(sessionName);
    backend.attachSession(sessionName, workdir, undefined, 'copilot');
    return;
  }

  try {
    const sm = new SessionManager(new TmuxBackendCore());
    const copilotInfo = await sm.createCopilotAndFinalize({
      workdir: os.homedir(),
      agentType,
      copilotMode: resolvedMode,
      sessionName,
      agentCommand: getAgentCommand(agentType),
    });

    sendCopilotOnboarding(backend, copilotInfo.sessionName, resolvedMode);
    backend.attachSession(copilotInfo.sessionName, copilotInfo.workdir, undefined, 'copilot');

    vscode.window.showInformationMessage(getCreatedMessage(sessionName, agentType, resolvedMode));
    vscode.commands.executeCommand('tmux.refresh');
  } catch (error) {
    void showHydraCommandError('Failed to create copilot', 'command.createCopilotWithAgent', error, {
      agent: agentType,
      copilotMode: resolvedMode,
      sessionName,
    });
  }
}

export async function createPlanCopilot(): Promise<void> {
  const agentType = await pickPlannerAgentType();
  if (!agentType) return;
  await createCopilotWithAgent(agentType, 'plan');
}

export async function createCopilot(): Promise<void> {
  const backend = getActiveBackend();
  if (!await ensureBackendInstalled(backend)) {
    return;
  }

  // Pick agent type
  const agentType = await pickAgentType();
  if (!agentType) return;

  const copilotMode = await pickModeForAgent(agentType);
  if (!copilotMode) return;

  // Ask for session name (default: hydra-copilot-<agent>)
  const defaultName = getDefaultSessionName(agentType, copilotMode);
  const nameInput = await vscode.window.showInputBox({
    prompt: 'Copilot session name',
    value: defaultName,
    placeHolder: defaultName,
  });
  if (!nameInput) return;

  const sessionName = backend.sanitizeSessionName(nameInput.trim());

  // Check if session already exists
  if (await backend.hasSession(sessionName)) {
    const action = await vscode.window.showInformationMessage(
      `Session "${sessionName}" already exists.`,
      'Attach',
      'Cancel'
    );
    if (action === 'Attach') {
      const workdir = await backend.getSessionWorkdir(sessionName);
      backend.attachSession(sessionName, workdir, undefined, 'copilot');
    }
    return;
  }

  try {
    const sm = new SessionManager(new TmuxBackendCore());
    const copilotInfo = await sm.createCopilotAndFinalize({
      workdir: os.homedir(),
      agentType,
      copilotMode,
      sessionName,
      name: nameInput.trim(),
      agentCommand: getAgentCommand(agentType),
    });

    sendCopilotOnboarding(backend, copilotInfo.sessionName, copilotMode);
    backend.attachSession(copilotInfo.sessionName, copilotInfo.workdir, undefined, 'copilot');

    vscode.window.showInformationMessage(getCreatedMessage(sessionName, agentType, copilotMode));
    vscode.commands.executeCommand('tmux.refresh');
  } catch (error) {
    void showHydraCommandError('Failed to create copilot', 'command.createCopilot', error, {
      agent: agentType,
      copilotMode,
      sessionName,
      requestedName: nameInput.trim(),
    });
  }
}
