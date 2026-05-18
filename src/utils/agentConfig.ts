import * as vscode from 'vscode';
import { AgentType } from '../core/types';
import { AGENT_LABELS, extractAgentCommandExecutable } from '../core/agentConfig';
import { resolveCommandPath } from '../core/exec';
import { updateHydraGlobalAgentCommands } from '../core/hydraGlobalConfig';

export type { AgentType } from '../core/types';
export { AGENT_LABELS, DEFAULT_AGENT_COMMANDS, buildAgentLaunchCommand } from '../core/agentConfig';

export async function detectAvailableAgents(): Promise<AgentType[]> {
  const agents: AgentType[] = ['claude', 'codex', 'gemini', 'sudocode'];
  const results = await Promise.all(agents.map(async (agent) => {
    const cmd = getAgentCommand(agent);
    const binary = extractAgentCommandExecutable(cmd);
    return await resolveCommandPath(binary) ? agent : null;
  }));
  return results.filter((a): a is AgentType => a !== null);
}

export function getDefaultAgent(): AgentType {
  return vscode.workspace
    .getConfiguration('hydra')
    .get<AgentType>('defaultAgent', 'claude');
}

export function getAgentCommand(agentType: string): string {
  const commands = getAgentCommands();
  return commands[agentType] || agentType;
}

export function getAgentCommands(): Record<string, string> {
  return vscode.workspace
    .getConfiguration('hydra')
    .get<Record<string, string>>('agentCommands', {
      claude: 'claude',
      codex: 'codex',
      gemini: 'gemini',
      sudocode: 'scode',
    });
}

export function syncAgentCommandsToHydraConfig(): void {
  updateHydraGlobalAgentCommands(getAgentCommands());
}

export async function pickAgentType(): Promise<AgentType | undefined> {
  const defaultAgent = getDefaultAgent();
  const items = (Object.keys(AGENT_LABELS) as AgentType[]).map(key => ({
    label: AGENT_LABELS[key],
    description: key === defaultAgent ? '(default)' : '',
    value: key,
  }));

  items.sort((a, b) => {
    if (a.value === defaultAgent) return -1;
    if (b.value === defaultAgent) return 1;
    return 0;
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select agent type',
  });
  return picked?.value;
}
