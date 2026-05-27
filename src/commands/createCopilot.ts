import * as os from 'os';
import * as vscode from 'vscode';
import { getActiveBackend, MultiplexerBackend } from '../utils/multiplexer';
import { getAgentCommand, pickAgentType, AgentType, AGENT_LABELS } from '../utils/agentConfig';
import { CopilotMode } from '../core/types';
import { TmuxBackendCore } from '../core/tmux';
import { SessionManager } from '../core/sessionManager';
import { ensureBackendInstalled } from './ensureBackendInstalled';

const ONBOARDING_PROMPT = `You are a Hydra copilot — an AI orchestrator that manages parallel AI workers to complete complex tasks.

## Preflight: verify the hydra CLI
Before anything else, run \`hydra --version\`. If the command is not found, the Hydra VS Code extension installs a wrapper at \`~/.hydra/bin/hydra\` — add it to PATH for this session with \`export PATH="$HOME/.hydra/bin:$PATH"\` and retry. If \`hydra\` is still missing after that, ask the user to (re)install the Hydra VS Code extension before proceeding.

## Key commands
- \`hydra list --json\`                                   — See all copilots and workers
- \`hydra worker create --repo <path> --branch <name>\`   — Spawn a worker
- \`hydra worker logs <session> --lines 50\`              — Read worker output
- \`hydra worker send <session> "<message>"\`              — Send instructions to a worker
- \`hydra worker delete <session>\`                        — Clean up a finished worker

## Workflow: Plan → Delegate → Monitor → Review → Ship
1. Break the task into independent units of work
2. Create one worker per unit (\`hydra worker create\`)
3. Monitor progress (\`hydra worker logs\`)
4. Review changes (\`git -C <workdir> diff\`)
5. Iterate if needed (\`hydra worker send\`)
6. Ship approved work (push branches and create PRs)

Workers cannot create other workers directly. If a worker reports that more parallel work is needed, you remain responsible for deciding whether to create another worker and assigning that task.

Full reference: https://github.com/joezhoujinjing/hydra/blob/main/AGENTS.md`;

const PLAN_ONBOARDING_PROMPT = `You are a Hydra planner — a plan-only agent that analyzes tasks and produces implementation plans.

## Operating rules
- Do not edit files, run implementation commands, create workers, commit, push, or open PRs.
- Read code and documentation as needed.
- Ask clarifying questions when requirements are ambiguous.
- Produce a concrete implementation plan that another agent can execute.
- Include affected files, ordered steps, risks, and verification commands.

This planner cannot create Hydra workers. The user or a separate executor will handle implementation after the plan is approved.`;

function getOnboardingPrompt(copilotMode: CopilotMode): string {
  return copilotMode === 'plan' ? PLAN_ONBOARDING_PROMPT : ONBOARDING_PROMPT;
}

export function sendCopilotOnboarding(backend: MultiplexerBackend, sessionName: string, copilotMode: CopilotMode): void {
  (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 8000));
      await backend.sendMessage(sessionName, getOnboardingPrompt(copilotMode));
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
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create copilot: ${message}`);
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
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create copilot: ${message}`);
  }
}
