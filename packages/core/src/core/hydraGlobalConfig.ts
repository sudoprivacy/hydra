import * as fs from 'fs';
import * as path from 'path';
import { getHydraConfigPath, getHydraHome, type HydraGlobalConfig } from './path';
import { AGENT_LABELS } from './agentConfig';
import type { AgentType } from './types';

export type { HydraGlobalConfig } from './path';

export const HYDRA_DEFAULT_AGENT_FALLBACK: AgentType = 'claude';

export type HydraDefaultAgentSource = 'configured' | 'fallback';

export interface HydraDefaultAgentResolution {
  agent: AgentType;
  source: HydraDefaultAgentSource;
}

const HYDRA_AGENT_TYPES = Object.keys(AGENT_LABELS) as AgentType[];

export function formatHydraAgentTypes(): string {
  return HYDRA_AGENT_TYPES.join(', ');
}

export function parseHydraDefaultAgent(agent: string): AgentType {
  const normalized = agent.trim().toLowerCase();
  if ((HYDRA_AGENT_TYPES as string[]).includes(normalized)) {
    return normalized as AgentType;
  }
  throw new Error(`Invalid default agent "${agent}". Expected one of: ${formatHydraAgentTypes()}.`);
}

/** Ensure Hydra data/config directories exist. */
export function ensureHydraGlobalConfig(): void {
  const hydraHome = getHydraHome();
  const hydraConfigDir = path.dirname(getHydraConfigPath());

  if (!fs.existsSync(hydraHome)) {
    fs.mkdirSync(hydraHome, { recursive: true });
  }
  if (!fs.existsSync(hydraConfigDir)) {
    fs.mkdirSync(hydraConfigDir, { recursive: true });
  }
}

export function readHydraGlobalConfig(): HydraGlobalConfig {
  ensureHydraGlobalConfig();
  const configPath = getHydraConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as HydraGlobalConfig
      : {};
  } catch {
    return {};
  }
}

export function writeHydraGlobalConfig(config: HydraGlobalConfig): void {
  ensureHydraGlobalConfig();
  fs.writeFileSync(getHydraConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function updateHydraGlobalAgentCommands(commands: Record<string, string>): void {
  const config = readHydraGlobalConfig();
  writeHydraGlobalConfig({
    ...config,
    agentCommands: {
      ...(config.agentCommands ?? {}),
      ...commands,
    },
  });
}

export function getHydraGlobalAgentCommand(agentType: string): string | undefined {
  return readHydraGlobalConfig().agentCommands?.[agentType];
}

export function hasHydraGlobalDefaultAgent(): boolean {
  const defaultAgent = readHydraGlobalConfig().defaultAgent;
  return typeof defaultAgent === 'string' && defaultAgent.trim().length > 0;
}

export function getHydraGlobalDefaultAgent(): HydraDefaultAgentResolution {
  const defaultAgent = readHydraGlobalConfig().defaultAgent;
  if (typeof defaultAgent !== 'string' || !defaultAgent.trim()) {
    return { agent: HYDRA_DEFAULT_AGENT_FALLBACK, source: 'fallback' };
  }
  return { agent: parseHydraDefaultAgent(defaultAgent), source: 'configured' };
}

export function setHydraGlobalDefaultAgent(agent: string): HydraDefaultAgentResolution {
  const parsedAgent = parseHydraDefaultAgent(agent);
  const config = readHydraGlobalConfig();
  writeHydraGlobalConfig({
    ...config,
    defaultAgent: parsedAgent,
  });
  return { agent: parsedAgent, source: 'configured' };
}

export function unsetHydraGlobalDefaultAgent(): HydraDefaultAgentResolution {
  const config = readHydraGlobalConfig();
  const nextConfig = { ...config };
  delete nextConfig.defaultAgent;
  writeHydraGlobalConfig(nextConfig);
  return { agent: HYDRA_DEFAULT_AGENT_FALLBACK, source: 'fallback' };
}
