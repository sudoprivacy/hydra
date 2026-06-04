#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { registerListCommand } from './commands/list';
import { registerWorkerCommands } from './commands/worker';
import { registerCopilotCommands } from './commands/copilot';
import { registerArchiveCommands } from './commands/archive';
import { registerRepoCommands } from './commands/repo';
import { registerDoctorCommand } from './commands/doctor';
import { registerWhoamiCommand } from './commands/whoami';
import { registerTestCommand } from './commands/test';
import { registerShareCommands } from './commands/share';
import { registerConfigCommands } from './commands/config';
import { peekTelemetry } from '../core/telemetry';
import { getHydraConfigPath, getHydraHome, getHydraLogFile } from '../core/path';
import { getHostSummary, logger } from '../core/logger';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
logger.debug('cli.start', 'Hydra CLI started', {
  version: pkg.version,
  command: process.argv[2],
  subcommand: process.argv[3],
  hydraHome: getHydraHome(),
  hydraConfigPath: getHydraConfigPath(),
  hydraLogFile: getHydraLogFile(),
  ...getHostSummary(),
});

const program = new Command();
program
  .name('hydra')
  .description('CLI for managing Hydra copilots and workers')
  .version(pkg.version)
  .option('--json', 'Output results as JSON')
  .option('--quiet', 'Suppress non-essential output')
  .option('--no-interactive', 'Disable interactive prompts (fail with error instead)');

// Auto-enable --json and --no-interactive when stdout is not a TTY (piped output)
if (!process.stdout.isTTY) {
  program.setOptionValue('json', true);
  program.setOptionValue('interactive', false);
}

let telemetryFlushed = false;
process.on('beforeExit', async () => {
  if (telemetryFlushed) {
    return;
  }
  // Only flush if the command actually instantiated the telemetry client.
  // Help-only paths and read-only commands never call getTelemetry(), so
  // they never create ~/.hydra/anonymous-id or print the first-run notice.
  const client = peekTelemetry();
  if (!client) {
    return;
  }
  telemetryFlushed = true;
  try {
    await client.flush();
  } catch {
    // never let telemetry crash the CLI
  }
  await logger.flush();
});

process.on('exit', () => {
  logger.flushSync();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.warn('cli.signal', 'Hydra CLI received signal', { signal });
    logger.flushSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

registerListCommand(program);
registerWorkerCommands(program);
registerCopilotCommands(program);
registerArchiveCommands(program);
registerRepoCommands(program);
registerDoctorCommand(program);
registerWhoamiCommand(program);
registerTestCommand(program);
registerShareCommands(program);
registerConfigCommands(program);

program.parse();
