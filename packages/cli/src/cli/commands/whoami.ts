import { Command } from 'commander';
import { resolve } from 'path';
import { type OutputOpts, outputResult } from '../output';
import { SessionManager, type WorkerInfo } from '@hydra/core/sessionManager';
import { TmuxBackendCore } from '@hydra/core/tmux';

interface WhoamiResult {
  role: 'worker';
  type: 'code' | 'task';
  sessionName: string;
  displayName: string;
  agent: string;
  sessionId: string | null;
  workdir: string;
  status: string;
  // Worker-specific
  workerId?: number;
  branch?: string | null;
  repo?: string | null;
  managedWorkdir?: boolean;
  copilotSessionName?: string | null;
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Report the Hydra worker context of the current working directory')
    .action(async () => {
      const globalOpts = program.opts() as OutputOpts;
      const cwd = resolve(process.cwd());

      const backend = new TmuxBackendCore();
      const sm = new SessionManager(backend);
      const state = await sm.sync();

      // Match cwd against worker workdirs
      for (const worker of Object.values(state.workers)) {
        if (cwd === resolve(worker.workdir) || cwd.startsWith(resolve(worker.workdir) + '/')) {
          const data: WhoamiResult = {
            role: 'worker',
            type: worker.source === 'directory' ? 'task' : 'code',
            sessionName: worker.sessionName,
            displayName: worker.displayName,
            agent: worker.agent,
            sessionId: worker.sessionId,
            workdir: worker.workdir,
            status: worker.status,
            workerId: worker.workerId,
            branch: worker.branch,
            repo: worker.repo,
            managedWorkdir: worker.managedWorkdir === true,
            copilotSessionName: worker.copilotSessionName,
          };

          outputResult(data as unknown as Record<string, unknown>, globalOpts, () => {
            prettyPrintWorker(worker);
          });
          return;
        }
      }

      // Not in a Hydra worker workdir
      if (globalOpts.json) {
        console.log(JSON.stringify({ role: null, message: 'Current directory is not inside a Hydra worker workdir.' }));
      } else if (!globalOpts.quiet) {
        console.log('Current directory is not inside a Hydra worker workdir.');
      }
    });
}

function prettyPrintWorker(worker: WorkerInfo): void {
  console.log('');
  console.log(`  Role:        worker`);
  console.log(`  Type:        ${worker.source === 'directory' ? 'task' : 'code'}`);
  console.log(`  Session:     ${worker.sessionName}`);
  console.log(`  Worker #:    ${worker.workerId}`);
  if (worker.source === 'directory') {
    console.log(`  Name:        ${worker.displayName || worker.slug}`);
  } else {
    console.log(`  Branch:      ${worker.branch}`);
    console.log(`  Repo:        ${worker.repo}`);
  }
  console.log(`  Agent:       ${worker.agent}`);
  console.log(`  Session ID:  ${worker.sessionId ?? '(none)'}`);
  console.log(`  Copilot:     ${worker.copilotSessionName ?? '(none)'}`);
  console.log(`  Workdir:     ${worker.workdir}`);
  if (worker.source === 'directory') {
    console.log(`  Managed:     ${worker.managedWorkdir === true ? 'yes' : 'no'}`);
  }
  console.log(`  Status:      ${worker.status}`);
  console.log('');
}
