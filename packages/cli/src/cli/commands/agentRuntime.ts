import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import type { ScodeAcpConfig, ScodeQuestionResponse } from '@hydra/core/scodeAcp';
import { registerCommandShutdown } from '../commandLifetime';

interface ConnectOptions {
  config: string;
  id: string;
  manualPermissions?: boolean;
  manualQuestions?: boolean;
  once?: string;
}

/**
 * Explicit foreground owner for scripts/agents without a long-lived desktop
 * service. This is a Hydra control stream; ACP framing remains in the SDK core.
 */
export function registerAgentRuntimeCommands(program: Command): void {
  program.command('agent-runtime')
    .description('Connect a foreground structured agent runtime (no terminal pane)')
    .command('connect')
    .requiredOption('--config <file>', 'JSON launch configuration: scodeArgv, workspace, optional acpSessionId/env/timeouts')
    .option('--id <id>', 'Runtime identifier for this foreground host', 'foreground')
    .option('--manual-permissions', 'Wait for explicit permission responses on stdin')
    .option('--manual-questions', 'Wait for explicit scode question responses on stdin')
    .option('--once <text>', 'Run one foreground prompt and stop; omit to keep idle notifications enabled')
    .addHelpText('after', '\nInput: newline JSON {id,op,...}. Ops: prompt(text), status, cancel, permission(requestId,optionId), question(requestId,answers), stop.\nOutput: newline JSON event/result/error records. EOF stops this command\'s owned CLI.\n')
    .action(async (options: ConnectOptions) => {
      try {
        await runForegroundConnector(options);
      } catch (error) {
        process.stderr.write(`Agent runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}

async function runForegroundConnector(options: ConnectOptions): Promise<void> {
  if (options.once !== undefined && (options.manualPermissions || options.manualQuestions)) {
    throw new Error('--once cannot wait for manual input; use the persistent connector for permissions/questions');
  }
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(options.config), 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Runtime config must be a JSON object');
  }
  const config = parsed as ScodeAcpConfig;
  const { AgentRuntimeRegistry } = await import('@hydra/core/agentRuntime');
  const registry = new AgentRuntimeRegistry();
  let stopping: Promise<void> | undefined;
  let closeInput = () => {};
  const stop = () => {
    stopping ??= registry.stopAll().finally(() => closeInput());
    return stopping;
  };
  const removeShutdown = registerCommandShutdown(stop);
  const output = (value: unknown) => {
    if (process.stdout.destroyed) return;
    // A disconnected/blocked consumer cannot accumulate an unbounded event log.
    if (process.stdout.writableLength > 4 * 1024 * 1024) {
      process.stderr.write('Agent runtime output consumer fell behind; stopping the foreground owner.\n');
      void stop();
      return;
    }
    process.stdout.write(JSON.stringify(value)+'\n');
  };
  const onOutputError = () => { void stop(); };
  process.stdout.on('error', onOutputError);
  const input = options.once === undefined ? createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false }) : undefined;
  input?.pause();
  closeInput = () => input?.close();
  const pending = new Set<Promise<void>>();
  const pendingIds = new Set<string | number>();
  const dispatch = async (line: string) => {
    let id: string | number | undefined;
    let ownsId = false;
    try {
      const command: unknown = JSON.parse(line);
      if (!command || typeof command !== 'object' || !('op' in command)) {
        throw new Error('Expected {id,op,...}');
      }
      const value = command as Record<string, unknown>;
      if (typeof value.id !== 'string' && typeof value.id !== 'number') {
        throw new Error('Command id must be a string or number');
      }
      id = value.id;
      if (pendingIds.has(id)) throw new Error('Command id is already pending');
      pendingIds.add(id);
      ownsId = true;
      const runtime = registry.get(options.id);
      if (!runtime) throw new Error('Runtime has not started');
      let result: unknown;
      switch (value.op) {
        case 'prompt':
          if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('prompt requires text');
          result = await runtime.prompt(value.text);
          break;
        case 'status': result = runtime.snapshot(); break;
        case 'cancel': await runtime.cancel(); result = { cancelRequested: true }; break;
        case 'permission':
          if (typeof value.requestId !== 'string' || (value.optionId !== null && typeof value.optionId !== 'string')) {
            throw new Error('permission requires requestId and optionId (or null)');
          }
          result = { answered: runtime.respondToPermission(value.requestId, value.optionId) };
          break;
        case 'question':
          if (typeof value.requestId !== 'string' || (value.answers !== null && !Array.isArray(value.answers))) {
            throw new Error('question requires requestId and answers (or null)');
          }
          result = { answered: runtime.respondToQuestion(value.requestId, value.answers as ScodeQuestionResponse['answers'] | null) };
          break;
        case 'stop': await stop(); input?.close(); result = { stopped: true }; break;
        default: throw new Error('Unknown agent runtime operation');
      }
      output({ type: 'result', id, result });
    } catch (error) {
      output({ type: 'error', id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (ownsId && id !== undefined) pendingIds.delete(id);
    }
  };
  const inputClosed = new Promise<void>(resolve => {
    if (!input) { resolve(); return; }
    input.on('line', line => {
      if (pending.size >= 128) {
        output({ type: 'error', error: 'Too many pending runtime commands' });
        return;
      }
      const job = dispatch(line);
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });
    input.once('close', () => {
      resolve();
      // EOF also cancels initialization or an unanswered startup input request.
      void stop().catch(() => { process.exitCode = 1; });
    });
  });

  try {
    const connecting = registry.connect(options.id, config, {
      permissionMode: options.manualPermissions ? 'manual' : 'cancel',
      inputMode: options.manualQuestions ? 'manual' : 'cancel',
      onEvent: event => {
        output({ type: 'event', event });
        if (event.type === 'status' && event.snapshot.status === 'error') {
          process.exitCode = 1;
          void stop();
        }
      },
    });
    input?.resume();
    const runtime = await connecting;
    if (stopping) return;
    output({ type: 'ready', runtime: runtime.snapshot() });
    if (options.once !== undefined) {
      output({ type: 'result', id: 'once', result: await runtime.prompt(options.once) });
      return;
    }
    // onEvent is connection-scoped. stdin controls this foreground ownership;
    // service/UI clients use AppService subscriptions and may detach separately.
    await inputClosed;
    await stop();
    await Promise.allSettled(pending);
  } finally {
    await stop();
    removeShutdown();
    process.stdout.removeListener('error', onOutputError);
  }
}
