import { Command } from 'commander';
import { TmuxBackendCore } from '@hydra/core/tmux';
import { isDirectoryWorker, SessionManager, ArchivedSessionInfo, type WorkerInfo } from '@hydra/core/sessionManager';
import { outputResult, outputError, type OutputOpts } from '../output';
import { awaitWorkerPostCreateOrPublishError } from '@hydra/core/workerAttentionNotifications';

function formatEntry(entry: ArchivedSessionInfo): Record<string, unknown> {
  const worker = entry.type === 'worker' ? entry.data as WorkerInfo : null;
  return {
    sessionName: entry.sessionName,
    type: entry.type,
    workerType: worker ? (isDirectoryWorker(worker) ? 'task' : 'code') : null,
    agentSessionId: entry.agentSessionId,
    agentSessionFile: entry.agentSessionFile || null,
    archivedAt: entry.archivedAt,
    agent: entry.data.agent,
    branch: worker?.branch || null,
    name: worker ? worker.displayName || worker.slug || null : null,
  };
}

function printEntry(entry: ArchivedSessionInfo): void {
  const worker = entry.type === 'worker' ? entry.data as WorkerInfo : null;
  const label = worker
    ? ` (${isDirectoryWorker(worker) ? (worker.displayName || worker.slug || 'task') : (worker.branch || 'unknown')})`
    : '';
  console.log(`  [${entry.type}] ${entry.sessionName}${label}`);
  console.log(`    Agent:      ${entry.data.agent}`);
  console.log(`    Session ID: ${entry.agentSessionId || 'none'}`);
  if (entry.agentSessionFile) console.log(`    Session file: ${entry.agentSessionFile}`);
  console.log(`    Archived:   ${entry.archivedAt}`);
}

export function registerArchiveCommands(program: Command): void {
  const archive = program
    .command('archive')
    .description('View and manage archived (deleted) sessions');

  archive
    .command('list')
    .description('List archived sessions (most recent per session by default)')
    .option('--all', 'Show every archive entry including duplicates')
    .action(async (opts: { all?: boolean }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const entries = opts.all ? sm.listArchived() : sm.listArchivedLatest();

        const data = {
          entries: entries.map(formatEntry),
          count: entries.length,
        };

        outputResult(data, globalOpts, () => {
          if (entries.length === 0) {
            console.log('No archived sessions.');
            return;
          }

          console.log('\nArchived Sessions:');
          console.log('\u2500'.repeat(60));
          for (const entry of entries) {
            printEntry(entry);
          }
          console.log('');
        });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  archive
    .command('view <session>')
    .description('View full history for an archived session (all entries)')
    .action(async (sessionName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const entries = sm.getArchivedAll(sessionName);

        if (entries.length === 0) {
          throw new Error(`Archived session "${sessionName}" not found`);
        }

        const data = {
          sessionName,
          entries: entries.map(e => ({
            ...formatEntry(e),
            data: e.data,
          })),
          count: entries.length,
        };

        outputResult(data, globalOpts, () => {
          console.log(`\nArchive history for: ${sessionName} (${entries.length} entries)`);
          console.log('\u2500'.repeat(60));
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            console.log(`\n  #${i + 1} [${entry.type}] archived ${entry.archivedAt}`);
            console.log(`    Agent Session ID: ${entry.agentSessionId || 'none'}`);
            console.log('    Metadata:');
            for (const [key, value] of Object.entries(entry.data)) {
              if (value != null) {
                console.log(`      ${key}: ${value}`);
              }
            }
          }
          console.log('');
        });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  archive
    .command('restore <session>')
    .description('Restore a worker or copilot from the most recent archive entry')
    .action(async (sessionName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const entry = sm.getArchived(sessionName);

        if (!entry) {
          throw new Error(`Archived session "${sessionName}" not found`);
        }

        if (entry.type === 'worker') {
          const { workerInfo, postCreatePromise } = await sm.restoreWorker(sessionName);
          const workerType = isDirectoryWorker(workerInfo) ? 'task' : 'code';
          outputResult(
            {
              status: 'restored',
              type: 'worker',
              workerType,
              session: workerInfo.sessionName,
              branch: workerInfo.branch,
              name: workerInfo.displayName || workerInfo.slug,
              agent: workerInfo.agent,
              workdir: workerInfo.workdir,
              agentSessionId: workerInfo.sessionId,
            },
            globalOpts,
            () => {
              console.log(`Restored worker: ${workerInfo.sessionName}`);
              console.log(`  Type:       ${workerType}`);
              if (workerType === 'task') {
                console.log(`  Name:       ${workerInfo.displayName || workerInfo.slug}`);
              } else {
                console.log(`  Branch:     ${workerInfo.branch}`);
              }
              console.log(`  Agent:      ${workerInfo.agent}`);
              console.log(`  Workdir:    ${workerInfo.workdir}`);
              console.log(`  Session ID: ${workerInfo.sessionId || 'none'}`);
            },
          );
          await awaitWorkerPostCreateOrPublishError(workerInfo, postCreatePromise, { eventSource: 'cli' });
        } else {
          const { copilotInfo, postCreatePromise } = await sm.restoreCopilot(sessionName);
          await postCreatePromise;
          const state = await sm.sync();
          const finalCopilot = state.copilots[copilotInfo.sessionName] || copilotInfo;
          outputResult(
            {
              status: 'restored',
              type: 'copilot',
              session: finalCopilot.sessionName,
              agent: finalCopilot.agent,
              workdir: finalCopilot.workdir,
              agentSessionId: finalCopilot.sessionId,
            },
            globalOpts,
            () => {
              console.log(`Restored copilot: ${finalCopilot.sessionName}`);
              console.log(`  Agent:      ${finalCopilot.agent}`);
              console.log(`  Workdir:    ${finalCopilot.workdir}`);
              console.log(`  Session ID: ${finalCopilot.sessionId || 'none'}`);
            },
          );
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
