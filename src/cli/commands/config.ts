import { Command } from 'commander';
import {
  getHydraGlobalDefaultAgent,
  setHydraGlobalDefaultAgent,
  unsetHydraGlobalDefaultAgent,
  type HydraDefaultAgentResolution,
} from '../../core/hydraGlobalConfig';
import { getHydraConfigPath } from '../../core/path';
import {
  inspectProjectPolicy,
  resolveEffectiveProjectConfig,
  validateProjectPolicyForRepo,
  type EffectiveProjectConfig,
  type ProjectPolicyInspection,
} from '../../core/projectPolicy';
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

function projectPolicyPayload(inspection: ProjectPolicyInspection): Record<string, unknown> {
  return {
    found: inspection.found,
    path: inspection.path,
    projectRoot: inspection.projectRoot,
    searchStart: inspection.searchStart,
    searchStop: inspection.searchStop,
    policy: inspection.policy,
    requiresTrust: inspection.requiresTrust,
    warnings: inspection.warnings,
    blockers: inspection.blockers,
  };
}

function effectivePayload(effective: EffectiveProjectConfig): Record<string, unknown> {
  return {
    defaultAgent: effective.defaultAgent,
    baseBranch: effective.baseBranch,
    worker: effective.worker,
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
    .action(async () => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const defaultAgent = getHydraGlobalDefaultAgent();
        const { projectPolicy, effective } = await resolveEffectiveProjectConfig({
          globalDefaultAgent: defaultAgent,
        });
        outputResult(
          {
            status: 'ok',
            path: getHydraConfigPath(),
            config: configPayload(defaultAgent),
            projectPolicy: projectPolicyPayload(projectPolicy),
            effective: effectivePayload(effective),
          },
          globalOpts,
          () => {
            console.log('Hydra config:');
            console.log(`  Default agent: ${defaultAgent.agent} (${formatSource(defaultAgent.source)})`);
            console.log(`  Effective agent: ${effective.defaultAgent.value} (${effective.defaultAgent.source})`);
            if (effective.baseBranch.value) {
              console.log(`  Project base:   ${effective.baseBranch.value} (${effective.baseBranch.source})`);
            }
            if (projectPolicy.found) {
              console.log(`  Project policy: ${projectPolicy.path}`);
            }
            console.log(`  Config file:    ${getHydraConfigPath()}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  config
    .command('doctor')
    .description('Validate project-level Hydra policy')
    .option('--path <path>', 'Directory or file used as the project policy search anchor')
    .action(async (opts: { path?: string }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const defaultAgent = getHydraGlobalDefaultAgent();
        const projectPolicy = await inspectProjectPolicy(opts.path);
        const repoIssues = await validateProjectPolicyForRepo(projectPolicy, projectPolicy.projectRoot);
        const blockers = [...projectPolicy.blockers, ...repoIssues];
        const warnings = projectPolicy.warnings;
        let effective: EffectiveProjectConfig | null = null;
        if (blockers.length === 0) {
          effective = (await resolveEffectiveProjectConfig({
            anchorPath: opts.path,
            globalDefaultAgent: defaultAgent,
          })).effective;
        }

        outputResult(
          {
            status: blockers.length === 0 ? 'ok' : 'blocked',
            path: getHydraConfigPath(),
            projectPolicy: {
              ...projectPolicyPayload(projectPolicy),
              blockers,
              warnings,
            },
            effective: effective ? effectivePayload(effective) : null,
            requiresTrust: projectPolicy.requiresTrust,
            blockers,
            warnings,
          },
          globalOpts,
          () => {
            if (!projectPolicy.found) {
              console.log('No project Hydra policy found.');
            } else {
              console.log(`Project Hydra policy: ${projectPolicy.path}`);
            }
            if (blockers.length > 0) {
              console.log(`Blockers: ${blockers.length}`);
              for (const blocker of blockers) {
                console.log(`  - ${blocker.message}`);
              }
            } else {
              console.log('Project Hydra policy: ok');
            }
            if (warnings.length > 0) {
              console.log(`Warnings: ${warnings.length}`);
              for (const warning of warnings) {
                console.log(`  - ${warning.message}`);
              }
            }
            if (projectPolicy.requiresTrust.length > 0) {
              console.log(`Requires trust: ${projectPolicy.requiresTrust.map(item => item.field).join(', ')}`);
            }
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
