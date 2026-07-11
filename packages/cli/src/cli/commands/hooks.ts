import { Command } from 'commander';
import { CompletionCoordinator } from '@hydra/core/completionCoordinator';
import { CompletionJobStore } from '@hydra/core/completionJobStore';
import { AgentHookEventCoordinator } from '@hydra/core/agentHookEventCoordinator';
import { EventLog } from '@hydra/core/events';
import { NotificationStore } from '@hydra/core/notifications';
import { outputError, outputResult, type OutputOpts } from '../output';
import { classifyWorkerNeedsInputEvent } from '@hydra/core/workerNeedsInputClassifier';
import { publishWorkerNeedsInputNotification } from '@hydra/core/workerAttentionNotifications';
import { readWorkerSessionById, readWorkerSessionByName } from '@hydra/core/sessionStateReader';
import { getAgentHookDiagnostic, listAgentHookDiagnostics } from '@hydra/core/agentHookAdapter';
import { SessionManager } from '@hydra/core/sessionManager';
import { TmuxBackendCore } from '@hydra/core/tmux';
import { WorkerRuntimeCoordinator } from '@hydra/core/workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from '@hydra/core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '@hydra/core/workerRuntimeV2';
import { getWorkerLifecycleEpoch } from '@hydra/core/workerIdentity';

interface NeedsInputHookOptions {
  agent?: string;
  session?: string;
  event?: string;
}

interface CompletionHookOptions {
  workerId?: string;
  lifecycleEpoch?: string;
  agent?: string;
}

interface AgentSignalHookOptions {
  workerId?: string;
  lifecycleEpoch?: string;
  agent?: string;
  event?: string;
}

export function registerHooksCommands(program: Command): void {
  const hooks = program
    .command('hooks', { hidden: true })
    .description('Internal Hydra agent hook commands');

  hooks
    .command('complete')
    .description('Ingest a structured agent completion hook event')
    .requiredOption('--worker-id <number>', 'Stable Hydra worker number')
    .requiredOption('--lifecycle-epoch <epoch>', 'Worker lifecycle epoch embedded in the hook')
    .option('--agent <agent>', 'Agent that emitted the completion hook')
    .action(async (opts: CompletionHookOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const workerId = parsePositiveInteger(opts.workerId, '--worker-id');
        const lifecycleEpoch = opts.lifecycleEpoch?.trim();
        if (!lifecycleEpoch) throw new Error('--lifecycle-epoch is required');
        await readStdinJson();

        const backend = new TmuxBackendCore();
        const sessionManager = new SessionManager(backend);
        await sessionManager.ensurePersistedWorkerIdentities();
        const runtimeStore = new WorkerRuntimeStateStoreV2();
        const compatibilityStore = new WorkerRuntimeStateStore();
        const eventLog = new EventLog();
        const resolveWorker = (candidateId: number) => {
          const worker = readWorkerSessionById(candidateId);
          if (!worker) return undefined;
          return {
            worker,
            lifecycleEpoch: getWorkerLifecycleEpoch(worker),
          };
        };
        const identity = resolveWorker(workerId);
        if (opts.agent && identity && opts.agent.trim() !== identity.worker.agent) {
          outputResult({ status: 'ignored', reason: 'agent-mismatch' }, globalOpts, () => {});
          return;
        }

        const runtimeCoordinator = new WorkerRuntimeCoordinator(
          candidateId => {
            const resolved = resolveWorker(candidateId);
            return resolved ? {
              workerId: candidateId,
              sessionName: resolved.worker.sessionName,
              lifecycleEpoch: resolved.lifecycleEpoch,
              agent: resolved.worker.agent,
              workdir: resolved.worker.workdir,
            } : undefined;
          },
          runtimeStore,
          compatibilityStore,
          eventLog,
        );
        const coordinator = new CompletionCoordinator({
          resolveWorker,
          jobStore: new CompletionJobStore(),
          runtimeStore,
          runtimeCoordinator,
          notificationStore: new NotificationStore(
            undefined,
            undefined,
            eventLog,
            compatibilityStore,
            Date.now,
            undefined,
            runtimeStore,
          ),
          deliverCompatibility: async (targetSession, message) => {
            const ownership = await sessionManager.assertHydraSessionOwnership(targetSession, 'copilot');
            if (!ownership.live) throw new Error(`Copilot session "${targetSession}" is not running`);
            await backend.sendMessage(targetSession, message);
          },
          eventSource: 'hook',
        });
        const result = await coordinator.complete({ workerId, lifecycleEpoch });
        outputResult(
          {
            status: result.outcome,
            outcome: result.outcome,
            job: result.job,
            notification: result.notification,
            runtime: result.runtime,
            compatibilityDelivered: result.compatibilityDelivered === true,
            migratedLegacyPending: result.migratedLegacyPending === true,
          },
          globalOpts,
          () => {
            console.log(`Completion signal for worker #${workerId}: ${result.outcome}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  hooks
    .command('capabilities [agent]')
    .description('Report normalized agent signal capabilities')
    .action((agent?: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const diagnostics = agent
          ? [getAgentHookDiagnostic(agent)]
          : listAgentHookDiagnostics();
        outputResult(
          { status: 'ok', agents: diagnostics },
          globalOpts,
          () => {
            for (const diagnostic of diagnostics) {
              const capabilities = Object.entries(diagnostic.capabilities)
                .map(([name, support]) => `${name}=${support}`)
                .join(', ');
              console.log(`${diagnostic.agentType}: ${capabilities}`);
            }
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  hooks
    .command('signal')
    .description('Ingest a normalized native agent hook event')
    .requiredOption('--worker-id <number>', 'Stable Hydra worker number')
    .requiredOption('--lifecycle-epoch <epoch>', 'Worker lifecycle epoch embedded in the hook')
    .requiredOption('--agent <agent>', 'Agent that emitted the hook event')
    .requiredOption('--event <event>', 'Native hook event name')
    .action(async (opts: AgentSignalHookOptions) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const workerId = parsePositiveInteger(opts.workerId, '--worker-id');
        const lifecycleEpoch = opts.lifecycleEpoch?.trim();
        if (!lifecycleEpoch) throw new Error('--lifecycle-epoch is required');
        const payload = await readStdinJson();
        const sessionManager = new SessionManager(new TmuxBackendCore());
        await sessionManager.ensurePersistedWorkerIdentities();

        const eventLog = new EventLog();
        const runtimeStore = new WorkerRuntimeStateStoreV2();
        const compatibilityStore = new WorkerRuntimeStateStore();
        const notificationStore = new NotificationStore(
          undefined,
          undefined,
          eventLog,
          compatibilityStore,
          Date.now,
          undefined,
          runtimeStore,
        );
        const coordinator = new AgentHookEventCoordinator({
          resolveWorker: candidateId => readWorkerSessionById(candidateId) ?? undefined,
          runtimeStore,
          compatibilityStore,
          notificationStore,
          completionJobStore: new CompletionJobStore(),
          eventLog,
          eventSource: 'hook',
        });
        const result = coordinator.process({
          workerId,
          lifecycleEpoch,
          agent: opts.agent || '',
          eventName: opts.event,
          payload,
        });
        outputResult(result, globalOpts, () => {
          if (result.status === 'ignored') {
            console.log(`Ignored ${opts.agent} ${opts.event} signal: ${result.reason}`);
          } else {
            console.log(`${result.status === 'duplicate' ? 'Duplicate' : 'Applied'} ${result.event.kind} signal for worker #${workerId}`);
          }
        });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

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
        const sessionManager = new SessionManager(new TmuxBackendCore());
        await sessionManager.ensurePersistedWorkerIdentities();
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

function parsePositiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}
