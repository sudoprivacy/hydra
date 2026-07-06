import { Command } from 'commander';
import {
  getHydraGlobalDefaultAgent,
  setHydraGlobalDefaultAgent,
  unsetHydraGlobalDefaultAgent,
  type HydraDefaultAgentResolution,
} from '@hydra/core/hydraGlobalConfig';
import { getHydraConfigPath } from '@hydra/core/path';
import { outputError, outputResult, type OutputOpts } from '../output';

type ConfigKey = 'default-agent';

function normalizeConfigKey(key: string): ConfigKey {
  const normalized = key.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

  if (normalized === 'default-agent') {
    return 'default-agent';
  }

  throw new Error(`Unknown config key "${key}". Expected: default-agent.`);
}

function formatSource(source: HydraDefaultAgentResolution['source']): string {
  return source === 'configured' ? 'configured' : 'fallback';
}

function configPayload(defaultAgent: HydraDefaultAgentResolution): Record<string, unknown> {
  return {
    defaultAgent: {
      value: defaultAgent.agent,
      source: defaultAgent.source,
    },
  };
}

function outputDefaultAgent(
  defaultAgent: HydraDefaultAgentResolution,
  globalOpts: OutputOpts,
  status: 'ok' | 'updated',
  prettyPrint: () => void,
): void {
  outputResult(
    {
      status,
      key: 'default-agent',
      value: defaultAgent.agent,
      source: defaultAgent.source,
      path: getHydraConfigPath(),
    },
    globalOpts,
    prettyPrint,
  );
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Show or update Hydra CLI settings');

  config
    .command('list')
    .description('Show Hydra CLI settings')
    .action(() => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const defaultAgent = getHydraGlobalDefaultAgent();
        outputResult(
          {
            status: 'ok',
            path: getHydraConfigPath(),
            config: configPayload(defaultAgent),
          },
          globalOpts,
          () => {
            console.log('Hydra config:');
            console.log(`  Default agent: ${defaultAgent.agent} (${formatSource(defaultAgent.source)})`);
            console.log(`  Config file:    ${getHydraConfigPath()}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  config
    .command('get <key>')
    .description('Show one Hydra CLI setting')
    .action((key: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const normalizedKey = normalizeConfigKey(key);
        if (normalizedKey === 'default-agent') {
          const defaultAgent = getHydraGlobalDefaultAgent();
          outputDefaultAgent(defaultAgent, globalOpts, 'ok', () => {
            console.log(defaultAgent.agent);
          });
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  config
    .command('set <key> <value>')
    .description('Set one Hydra CLI setting')
    .action((key: string, value: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const normalizedKey = normalizeConfigKey(key);
        if (normalizedKey === 'default-agent') {
          const defaultAgent = setHydraGlobalDefaultAgent(value);
          outputDefaultAgent(defaultAgent, globalOpts, 'updated', () => {
            console.log(`Default agent: ${defaultAgent.agent}`);
          });
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  config
    .command('unset <key>')
    .description('Unset one Hydra CLI setting')
    .action((key: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const normalizedKey = normalizeConfigKey(key);
        if (normalizedKey === 'default-agent') {
          const defaultAgent = unsetHydraGlobalDefaultAgent();
          outputDefaultAgent(defaultAgent, globalOpts, 'updated', () => {
            console.log(`Default agent: ${defaultAgent.agent} (${formatSource(defaultAgent.source)})`);
          });
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
