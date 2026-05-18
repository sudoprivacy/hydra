import * as fs from 'fs';
import * as path from 'path';
import { getHydraConfigPath, getHydraHome } from './path';

export interface HydraGlobalConfig {
  cli?: {
    extensionPath?: string;
    version?: string;
  };
  agentCommands?: Record<string, string>;
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
