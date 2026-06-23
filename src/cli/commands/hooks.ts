import { Command } from 'commander';
import { outputError, outputResult, type OutputOpts } from '../output';
import { classifyWorkerNeedsInputEvent } from '../../core/workerNeedsInputClassifier';
import { publishWorkerNeedsInputNotification } from '../../core/workerAttentionNotifications';
import { readWorkerSessionByName } from '../../core/sessionStateReader';

interface NeedsInputHookOptions {
  agent?: string;
  session?: string;
  event?: string;
}

export function registerHooksCommands(program: Command): void {
  const hooks = program
    .command('hooks', { hidden: true })
    .description('Internal Hydra agent hook commands');

  hooks
    .command('needs-input')
    .description('Ingest a structured agent needs-input hook event')
    .requiredOption('--agent <agent>', 'Agent that emitted the hook event')
    .requiredOption('--session <session>', 'Hydra worker session that owns the hook')
    .option('--event <event>', 'Hook event name')
    .action(async (opts: NeedsInputHookOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const payload = await readStdinJson();
        const worker = readWorkerSessionByName(opts.session || '');
        if (!worker) {
          outputResult({ status: 'ignored', reason: 'worker-not-found' }, globalOpts, () => {});
          return;
        }

        const signal = classifyWorkerNeedsInputEvent({
          agent: opts.agent || worker.agent,
          eventName: opts.event,
          payload,
        });
        if (!signal) {
          outputResult({ status: 'ignored', reason: 'not-needs-input' }, globalOpts, () => {});
          return;
        }

        const result = publishWorkerNeedsInputNotification(worker, signal, { eventSource: 'hook' });
        if (result.skipped) {
          outputResult({ status: 'ignored', reason: result.skipped }, globalOpts, () => {});
          return;
        }
        outputResult(
          {
            status: result.created ? 'created' : 'exists',
            created: result.created,
            notification: result.notification,
          },
          globalOpts,
          () => {
            const verb = result.created ? 'Created' : 'Existing';
            console.log(`${verb} needs-input notification ${result.notification.id}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}
