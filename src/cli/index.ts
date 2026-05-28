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

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

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
});

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
