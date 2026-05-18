import * as path from 'path';
import { Command } from 'commander';
import { TmuxBackendCore } from '../../core/tmux';
import { SessionManager } from '../../core/sessionManager';
import { toCanonicalPath, resolveAgentSessionFile } from '../../core/path';
import { resolveRepoInput } from '../../core/repoRegistry';
import { fetchOriginRequired } from '../../core/git';
import { outputResult, outputError, type OutputOpts } from '../output';
import { getTelemetry, normalizeAgentForTelemetry } from '../../core/telemetry';

function expandPath(p: string): string {
  const canonical = toCanonicalPath(p);
  if (canonical) {
    return canonical;
  }

  const trimmed = p.trim();
  if (trimmed.startsWith('~')) {
    throw new Error(`Could not resolve home-relative path: ${p}`);
  }

  return path.resolve(trimmed);
}

function requireSessionName(sessionName: string): string {
  const trimmed = sessionName.trim();
  if (!trimmed) {
    throw new Error('Session name is required');
  }
  return trimmed;
}

export function registerCopilotCommands(program: Command): void {
  const copilot = program
    .command('copilot')
    .description('Manage Hydra copilots');

  copilot
    .command('create')
    .description('Create a new copilot')
    .option('--workdir <path>', 'Working directory for the copilot', process.cwd())
    .option('--repo <identifier>', 'Run inside a registered repo: <owner/name> or absolute path (overrides --workdir)')
    .option('--agent <type>', 'Agent type (claude, codex, gemini, sudocode)', 'claude')
    .option('--name <name>', 'Display name for the copilot session')
    .option('--session <name>', 'Explicit tmux session name')
    .action(async (opts: { workdir: string; repo?: string; agent: string; name?: string; session?: string }) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const requestedSession = opts.session || opts.name || `hydra-copilot-${opts.agent}`;
        const sessionName = backend.sanitizeSessionName(requestedSession);

        let workdir: string;
        if (opts.repo) {
          const resolved = resolveRepoInput(opts.repo);
          workdir = resolved.path;
          if (resolved.isManaged) {
            await fetchOriginRequired(workdir);
          }
        } else {
          workdir = expandPath(opts.workdir);
        }

        const finalCopilot = await sm.createCopilotAndFinalize({
          workdir,
          agentType: opts.agent,
          name: opts.name,
          sessionName,
        });

        getTelemetry().capture('copilot_created', {
          agent: normalizeAgentForTelemetry(finalCopilot.agent),
        });

        outputResult(
          {
            status: 'created',
            session: finalCopilot.sessionName,
            agent: finalCopilot.agent,
            workdir: finalCopilot.workdir,
            agentSessionId: finalCopilot.sessionId,
          },
          globalOpts,
          () => {
            console.log(`Created copilot: ${finalCopilot.sessionName}`);
            console.log(`  Agent:      ${finalCopilot.agent}`);
            console.log(`  Workdir:    ${finalCopilot.workdir}`);
            console.log(`  Session ID: ${finalCopilot.sessionId || 'none'}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  copilot
    .command('delete <session>')
    .description('Delete a copilot (kill session + archive metadata)')
    .action(async (sessionName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const validatedSessionName = requireSessionName(sessionName);
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        await sm.deleteCopilot(validatedSessionName);

        getTelemetry().capture('copilot_deleted');

        outputResult(
          { status: 'deleted', session: validatedSessionName },
          globalOpts,
          () => console.log(`Deleted copilot: ${validatedSessionName}`),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  copilot
    .command('restore <session>')
    .description('Restore an archived copilot by session name')
    .action(async (sessionName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const validatedSessionName = requireSessionName(sessionName);
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const finalCopilot = await sm.restoreCopilotAndFinalize(validatedSessionName);

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
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  copilot
    .command('rename <session> <new-name>')
    .description('Rename a copilot session')
    .action(async (sessionName: string, newName: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const copilot = await sm.renameCopilot(sessionName, newName);

        outputResult(
          { status: 'renamed', oldSession: sessionName, newSession: copilot.sessionName },
          globalOpts,
          () => console.log(`Renamed copilot: ${sessionName} -> ${copilot.sessionName}`),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  copilot
    .command('logs <session>')
    .description('Read copilot terminal output')
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
        const [output, copilot] = await Promise.all([
          backend.capturePane(sessionName, lines),
          sm.getCopilot(sessionName),
        ]);
        const sessionFile = copilot
          ? resolveAgentSessionFile(copilot.agent, copilot.workdir, copilot.sessionId, copilot.agentSessionFile)
          : null;

        outputResult(
          { session: sessionName, lines, output, sessionId: copilot?.sessionId ?? null, sessionFile },
          globalOpts,
          () => process.stdout.write(output),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  copilot
    .command('send <session> <message>')
    .description('Send a message to a copilot')
    .action(async (sessionName: string, message: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        await backend.sendMessage(sessionName, message);

        outputResult(
          { status: 'sent', session: sessionName, message },
          globalOpts,
          () => {
            const truncated = message.length > 60 ? message.substring(0, 60) + '...' : message;
            console.log(`Sent to ${sessionName}: ${truncated}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
