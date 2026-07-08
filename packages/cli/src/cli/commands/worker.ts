import { Command } from 'commander';
import * as path from 'path';
import { TmuxBackendCore } from '@hydra/core/tmux';
import { isDirectoryWorker, SessionManager, type WorkerInfo } from '@hydra/core/sessionManager';
import { getRepoRootFromPath, localBranchExists } from '@hydra/core/git';
import { expandAndResolvePath, resolveAgentSessionFile } from '@hydra/core/path';
import { resolveRepoInput } from '@hydra/core/repoRegistry';
import { outputResult, outputError, type OutputOpts } from '../output';
import { detectCurrentTmuxIdentity, detectIdentity, getWorkerCreationBlockedMessage } from '../identity';
import { getTelemetry, normalizeAgentForTelemetry } from '@hydra/core/telemetry';
import { agentSupportsCompletionNotification } from '@hydra/core/agentConfig';
import { getHydraGlobalDefaultAgent } from '@hydra/core/hydraGlobalConfig';
import { awaitWorkerPostCreateOrPublishError } from '@hydra/core/workerAttentionNotifications';
import { setWorkerRuntimeState } from '@hydra/core/workerRuntimeState';

type WorkerCreateCliOpts = {
  repo?: string;
  branch?: string;
  dir?: string;
  temp?: boolean;
  name?: string;
  base?: string;
};

type ResolvedCreateMode =
  | { type: 'code'; repo: string; branch: string }
  | { type: 'task'; workdir?: string; name?: string; managedWorkdir: boolean };

function getDirectoryName(inputPath: string): string {
  return path.basename(inputPath.replace(/[\\/]+$/, '')) || 'task';
}

async function tryGetCurrentRepoRoot(): Promise<string | null> {
  try {
    return await getRepoRootFromPath(process.cwd());
  } catch {
    return null;
  }
}

async function resolveCreateMode(opts: WorkerCreateCliOpts): Promise<ResolvedCreateMode> {
  const taskModeRequested = !!opts.dir || opts.temp === true;

  if (opts.repo && taskModeRequested) {
    throw new Error('--repo cannot be used with --dir or --temp.');
  }
  if (opts.dir && opts.temp) {
    throw new Error('--dir and --temp are mutually exclusive.');
  }

  if (taskModeRequested) {
    if (opts.branch) {
      throw new Error('--branch is only valid for code workers.');
    }
    if (opts.base) {
      throw new Error('--base is only valid for code workers.');
    }
    if (opts.temp) {
      if (!opts.name?.trim()) {
        throw new Error('--name is required when using --temp.');
      }
      return { type: 'task', name: opts.name.trim(), managedWorkdir: true };
    }

    const workdir = expandAndResolvePath(opts.dir!);
    return {
      type: 'task',
      workdir,
      name: opts.name?.trim() || getDirectoryName(workdir),
      managedWorkdir: false,
    };
  }

  if (opts.repo) {
    if (!opts.branch?.trim()) {
      throw new Error('--branch is required when using --repo.');
    }
    if (opts.name) {
      throw new Error('--name is only valid for task workers.');
    }
    return { type: 'code', repo: opts.repo, branch: opts.branch.trim() };
  }

  const currentRepoRoot = await tryGetCurrentRepoRoot();
  if (currentRepoRoot) {
    if (!opts.branch?.trim()) {
      throw new Error(
        'Current directory is a git repository. --branch is required to create a code worker; use --dir or --temp to create a task worker.',
      );
    }
    if (opts.name) {
      throw new Error('--name is only valid for task workers.');
    }
    return { type: 'code', repo: currentRepoRoot, branch: opts.branch.trim() };
  }

  if (opts.branch?.trim()) {
    throw new Error('--branch requires --repo or a current directory inside a git repository.');
  }
  if (opts.base) {
    throw new Error('--base is only valid for code workers.');
  }

  const workdir = expandAndResolvePath(process.cwd());
  return {
    type: 'task',
    workdir,
    name: opts.name?.trim() || getDirectoryName(workdir),
    managedWorkdir: false,
  };
}

export function registerWorkerCommands(program: Command): void {
  const worker = program
    .command('worker')
    .description('Manage Hydra workers');

  worker
    .command('create')
    .description('Create a new worker')
    .option('--repo <path>', 'Path to the repository for a code worker')
    .option('--branch <name>', 'Branch name for a code worker')
    .option('--dir <path>', 'Directory for a task worker')
    .option('--temp', 'Create a Hydra-managed task worker folder')
    .option('--name <name>', 'Task worker name')
    .option('--agent <type>', 'Agent type override (claude, codex, gemini, antigravity, sudocode, custom)')
    .option('--base <branch>', 'Base branch override')
    .option('--task <prompt>', 'Task prompt for the agent')
    .option('--task-file <path>', 'Path to a file containing the task description')
    .option('--copilot <session>', 'Session name of the parent copilot (auto-detected if inside a copilot)')
    .option('--notify-copilot', 'Notify parent copilot when worker completes (default: true)', true)
    .option('--no-notify-copilot', 'Disable completion notification to parent copilot')
    .action(async (opts: {
      repo?: string;
      branch?: string;
      dir?: string;
      temp?: boolean;
      name?: string;
      agent?: string;
      base?: string;
      task?: string;
      taskFile?: string;
      copilot?: string;
      notifyCopilot: boolean;
    }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const identity = await detectCurrentTmuxIdentity() || detectIdentity();
        if (identity?.role === 'worker') {
          throw new Error(getWorkerCreationBlockedMessage(identity));
        }

        const agentType = opts.agent || getHydraGlobalDefaultAgent().agent;

        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);

        // Auto-detect parent copilot if --copilot not explicitly set
        let copilotSessionName = opts.copilot;
        if (!copilotSessionName) {
          if (identity?.role === 'copilot') {
            copilotSessionName = identity.sessionName;
          }
        }

        const mode = await resolveCreateMode(opts);
        let workerInfo: WorkerInfo;
        let postCreatePromise: Promise<void>;
        let status = 'created';

        if (mode.type === 'code') {
          // Single dispatch helper: handles short-form, abs paths, and explicit
          // relative paths (`.`, `./foo`, `../foo`). Decides managed-ness against
          // the resolved (pre-rev-parse) path so the macOS /var → /private/var
          // realpath flip in `git rev-parse --show-toplevel` doesn't defeat the
          // comparison against ~/.hydra/repos/.
          const { path: repoPath, isManaged: isManagedRepo } = resolveRepoInput(mode.repo);
          const repoRoot = await getRepoRootFromPath(repoPath);
          const branchExisted = await localBranchExists(repoRoot, mode.branch);

          const result = await sm.createWorker({
            repoRoot,
            branchName: mode.branch,
            agentType,
            baseBranchOverride: opts.base,
            task: opts.task,
            taskFile: opts.taskFile,
            copilotSessionName,
            notifyCopilot: opts.notifyCopilot,
            fetchMode: isManagedRepo ? 'required' : 'best-effort',
          });
          workerInfo = result.workerInfo;
          postCreatePromise = result.postCreatePromise;
          status = branchExisted ? 'exists' : 'created';
        } else {
          const result = await sm.createDirectoryWorker({
            workdir: mode.workdir,
            name: mode.name,
            managedWorkdir: mode.managedWorkdir,
            agentType,
            task: opts.task,
            taskFile: opts.taskFile,
            copilotSessionName,
            notifyCopilot: opts.notifyCopilot,
          });
          workerInfo = result.workerInfo;
          postCreatePromise = result.postCreatePromise;
        }

        const type = isDirectoryWorker(workerInfo) ? 'task' : 'code';

        getTelemetry().capture(
          status === 'exists' ? 'worker_resumed' : 'worker_created',
          { agent: normalizeAgentForTelemetry(workerInfo.agent), workerType: type },
        );

        outputResult(
          {
            status,
            type,
            session: workerInfo.sessionName,
            branch: workerInfo.branch,
            name: workerInfo.displayName || workerInfo.slug,
            agent: workerInfo.agent,
            workdir: workerInfo.workdir,
            managedWorkdir: workerInfo.managedWorkdir === true,
          },
          globalOpts,
          () => {
            const label = status === 'exists' ? 'Worker resumed' : 'Worker created';
            console.log(`${label}: ${workerInfo.sessionName}`);
            console.log(`  Type:     ${type}`);
            if (type === 'task') {
              console.log(`  Name:     ${workerInfo.displayName || workerInfo.slug}`);
            } else {
              console.log(`  Branch:   ${workerInfo.branch}`);
            }
            console.log(`  Agent:    ${workerInfo.agent}`);
            console.log(`  Workdir:  ${workerInfo.workdir}`);
            console.log(`  Session:  ${workerInfo.tmuxSession}`);
          },
        );

        // Wait for delayed Enter (Claude trust prompt) before exiting
        await awaitWorkerPostCreateOrPublishError(workerInfo, postCreatePromise, { eventSource: 'cli' });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('delete <session>')
    .description('Delete a worker')
    .option('--delete-files', 'Delete files for Hydra-managed temp task worker folders')
    .action(async (sessionName: string, opts: { deleteFiles?: boolean }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const workerInfo = await sm.getWorker(sessionName);
        const workerType = workerInfo ? (isDirectoryWorker(workerInfo) ? 'task' : 'code') : undefined;
        await sm.deleteWorker(sessionName, { deleteFiles: opts.deleteFiles === true });

        getTelemetry().capture('worker_deleted', {
          workerType,
          deleteFiles: opts.deleteFiles === true,
        });

        outputResult(
          { status: 'deleted', session: sessionName, deleteFiles: opts.deleteFiles === true },
          globalOpts,
          () => console.log(`Deleted worker: ${sessionName}`),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('stop <session>')
    .description('Stop a worker (kill tmux session, keep workdir)')
    .action(async (sessionName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        await sm.stopWorker(sessionName);

        outputResult(
          { status: 'stopped', session: sessionName },
          globalOpts,
          () => console.log(`Stopped worker: ${sessionName}`),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('start <session>')
    .description('Start a stopped worker')
    .option('--agent <type>', 'Agent type override')
    .action(async (sessionName: string, opts: { agent?: string }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const { workerInfo, postCreatePromise } = await sm.startWorker(sessionName, opts.agent);

        outputResult(
          {
            status: 'started',
            session: workerInfo.sessionName,
            agent: workerInfo.agent,
            workdir: workerInfo.workdir,
          },
          globalOpts,
          () => {
            console.log(`Started worker: ${workerInfo.sessionName}`);
            console.log(`  Agent:  ${workerInfo.agent}`);
            console.log(`  Workdir: ${workerInfo.workdir}`);
          },
        );

        await awaitWorkerPostCreateOrPublishError(workerInfo, postCreatePromise, { eventSource: 'cli' });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('rename <session> <new-branch>')
    .description('Rename a code worker (branch, worktree, and session)')
    .action(async (sessionName: string, newBranch: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const worker = await sm.renameWorker(sessionName, newBranch);

        outputResult(
          {
            status: 'renamed',
            oldSession: sessionName,
            session: worker.sessionName,
            branch: worker.branch,
            workdir: worker.workdir,
          },
          globalOpts,
          () => {
            console.log(`Renamed worker: ${sessionName} -> ${worker.sessionName}`);
            console.log(`  Branch:   ${worker.branch}`);
            console.log(`  Workdir:  ${worker.workdir}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('logs <session>')
    .description('Read worker terminal output')
    .option('--lines <n>', 'Number of lines to capture', '50')
    .action(async (sessionName: string, opts: { lines: string }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const lines = parseInt(opts.lines, 10);
        if (isNaN(lines) || lines <= 0) {
          throw new Error('Invalid --lines value: must be a positive integer');
        }

        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const [output, worker] = await Promise.all([
          backend.capturePane(sessionName, lines),
          sm.getWorker(sessionName),
        ]);
        const sessionFile = worker
          ? resolveAgentSessionFile(worker.agent, worker.workdir, worker.sessionId, worker.agentSessionFile)
          : null;

        outputResult(
          { session: sessionName, lines, output, sessionId: worker?.sessionId ?? null, sessionFile },
          globalOpts,
          () => process.stdout.write(output),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  worker
    .command('send <session> <message>')
    .description('Send a message to a worker')
    .option('--all', 'Broadcast to all running workers (session arg is the message)')
    .action(async (sessionOrMessage: string, messageOrUndefined: string, opts: { all?: boolean }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const identity = detectIdentity();

        if (opts.all) {
          // When --all, first positional is the message, second is undefined/empty
          const message = sessionOrMessage;
          const sm = new SessionManager(backend);
          const state = await sm.sync();
          const running = Object.values(state.workers).filter(w => w.status === 'running');

          if (running.length === 0) {
            throw new Error('No running workers found');
          }

          const sent: string[] = [];
          for (const worker of running) {
            if (
              identity?.role === 'copilot' &&
              worker.copilotSessionName === identity.sessionName &&
              agentSupportsCompletionNotification(worker.agent)
            ) {
              sm.armCompletionNotification(worker.sessionName);
            }
            await backend.sendMessage(worker.sessionName, message);
            markWorkerRunning(worker, 'worker-send');
            sent.push(worker.sessionName);
          }

          outputResult(
            { status: 'sent', sessions: sent, message },
            globalOpts,
            () => {
              const truncated = message.length > 60 ? message.substring(0, 60) + '...' : message;
              for (const s of sent) {
                console.log(`Sent to ${s}: ${truncated}`);
              }
            },
          );
        } else {
          const session = sessionOrMessage;
          const message = messageOrUndefined;
          const sm = new SessionManager(backend);
          const worker = await sm.getWorker(session);
          if (
            identity?.role === 'copilot' &&
            worker?.copilotSessionName === identity.sessionName &&
            agentSupportsCompletionNotification(worker.agent)
          ) {
            sm.armCompletionNotification(session);
          }
          await backend.sendMessage(session, message);
          if (worker) {
            markWorkerRunning(worker, 'worker-send');
          }

          outputResult(
            { status: 'sent', session, message },
            globalOpts,
            () => {
              const truncated = message.length > 60 ? message.substring(0, 60) + '...' : message;
              console.log(`Sent to ${session}: ${truncated}`);
            },
          );
        }
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

function markWorkerRunning(worker: WorkerInfo, reason: string): void {
  try {
    setWorkerRuntimeState({
      sessionName: worker.sessionName,
      state: 'running',
      origin: 'manual',
      reason,
      workerId: worker.workerId,
      agent: worker.agent,
      workdir: worker.workdir,
    }, 'cli');
  } catch {
    // Best-effort: sending the message is the user-visible operation.
  }
}
