import { Command } from 'commander';
import { TmuxBackendCore } from '../../core/tmux';
import { SessionManager } from '../../core/sessionManager';
import {
  AgentSessionIndexStore,
  AgentSessionInspectConflictError,
  AgentSessionInspectNotFoundError,
  filterAgentSessionEntries,
  inspectAgentSessionIndex,
  selectAgentSessionListEntries,
  type AgentSessionIndexEntry,
  type AgentSessionIndexSource,
  type AgentSessionListFilters,
  type AgentSessionRole,
  type AgentSessionStatus,
} from '../../core/agentSessionIndex';
import {
  EXIT_CONFLICT,
  EXIT_NOT_FOUND,
  outputError,
  outputResult,
  type OutputOpts,
} from '../output';

interface SessionListOpts {
  all?: boolean;
  role?: string;
  source?: string;
  lifecycle?: string;
  agent?: string;
  status?: string;
}

export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Inspect Hydra agent session index');

  session
    .command('list')
    .description('List agent sessions from the rebuilt local index')
    .option('--all', 'Show every archive entry, including history hidden by the default active-wins view')
    .option('--role <role>', 'Filter by role: worker or copilot')
    .option('--source <source>', 'Filter by source: active or archive')
    .option('--lifecycle <source>', 'Alias for --source')
    .option('--agent <agent>', 'Filter by agent name')
    .option('--status <status>', 'Filter by status: running, stopped, or archived')
    .action(async (opts: SessionListOpts) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const index = await rebuildIndex();
        const filters = parseListFilters(opts);
        const selected = selectAgentSessionListEntries(index.sessions, opts.all === true);
        const sessions = filterAgentSessionEntries(selected, filters);

        outputResult(
          {
            status: 'ok',
            file: new AgentSessionIndexStore().path,
            generatedAt: index.generatedAt,
            sessions,
            count: sessions.length,
          },
          globalOpts,
          () => printSessionList(sessions, opts.all === true),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  session
    .command('inspect <query>')
    .description('Inspect one agent session by record id, Hydra session, agent session id, or session file')
    .action(async (query: string) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const index = await rebuildIndex();
        const found = inspectAgentSessionIndex(index, query);
        outputResult(
          {
            status: 'ok',
            file: new AgentSessionIndexStore().path,
            generatedAt: index.generatedAt,
            session: found,
          },
          globalOpts,
          () => printSessionDetail(found),
        );
      } catch (error) {
        outputSessionInspectError(error, globalOpts);
      }
    });

  session
    .command('rebuild')
    .description('Rebuild the local agent session index')
    .action(async () => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const index = await rebuildIndex();
        outputResult(
          {
            status: 'rebuilt',
            file: new AgentSessionIndexStore().path,
            generatedAt: index.generatedAt,
            sessions: index.sessions,
            count: index.sessions.length,
          },
          globalOpts,
          () => {
            console.log(`Rebuilt agent session index: ${new AgentSessionIndexStore().path}`);
            console.log(`  Sessions: ${index.sessions.length}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}

async function rebuildIndex(): Promise<ReturnType<AgentSessionIndexStore['rebuild']>> {
  const backend = new TmuxBackendCore();
  const sm = new SessionManager(backend);
  const state = await sm.sync();
  const archiveEntries = sm.listArchived();
  const store = new AgentSessionIndexStore();
  return store.rebuild({ state, archiveEntries });
}

function parseListFilters(opts: SessionListOpts): AgentSessionListFilters {
  const source = opts.source ?? opts.lifecycle;
  if (opts.source && opts.lifecycle && opts.source !== opts.lifecycle) {
    throw new Error('--source and --lifecycle cannot be used with different values');
  }
  return {
    role: parseRole(opts.role),
    source: parseSource(source),
    agent: opts.agent,
    status: parseStatus(opts.status),
  };
}

function parseRole(value: string | undefined): AgentSessionRole | undefined {
  if (value == null) return undefined;
  if (value === 'worker' || value === 'copilot') return value;
  throw new Error('--role is only valid for "worker" or "copilot"');
}

function parseSource(value: string | undefined): AgentSessionIndexSource | undefined {
  if (value == null) return undefined;
  if (value === 'active' || value === 'archive') return value;
  throw new Error('--source is only valid for "active" or "archive"');
}

function parseStatus(value: string | undefined): AgentSessionStatus | undefined {
  if (value == null) return undefined;
  if (value === 'running' || value === 'stopped' || value === 'archived') return value;
  throw new Error('--status is only valid for "running", "stopped", or "archived"');
}

function printSessionList(sessions: AgentSessionIndexEntry[], includeAll: boolean): void {
  if (sessions.length === 0) {
    console.log('No agent sessions found.');
    return;
  }

  console.log(includeAll ? 'Agent Sessions (all records):' : 'Agent Sessions:');
  for (const session of sessions) {
    const id = session.agentSessionId || 'none';
    console.log(`  [${session.source}/${session.role}/${session.status}] ${session.hydraSessionName} (${session.agent})`);
    console.log(`    record: ${session.recordId}`);
    console.log(`    agent session: ${id}`);
    if (session.resolvedAgentSessionFile) {
      console.log(`    file: ${session.resolvedAgentSessionFile}`);
    }
  }
}

function printSessionDetail(session: AgentSessionIndexEntry): void {
  console.log(`${session.hydraSessionName}`);
  console.log(`  Record:        ${session.recordId}`);
  console.log(`  Source:        ${session.source}`);
  console.log(`  Role:          ${session.role}`);
  console.log(`  Agent:         ${session.agent}`);
  console.log(`  Status:        ${session.status}`);
  console.log(`  Session ID:    ${session.agentSessionId || 'none'}`);
  console.log(`  Session file:  ${session.resolvedAgentSessionFile || 'none'}`);
  if (session.archivedAt) {
    console.log(`  Archived:      ${session.archivedAt}`);
  }
  if (session.workdir) {
    console.log(`  Workdir:       ${session.workdir}`);
  }
}

function outputSessionInspectError(error: unknown, opts: OutputOpts): never {
  if (error instanceof AgentSessionInspectConflictError) {
    if (opts.json) {
      console.error(JSON.stringify({
        error: {
          code: EXIT_CONFLICT,
          message: error.message,
          retryable: false,
          candidates: error.candidates,
        },
      }));
    } else {
      console.error(`Error: ${error.message}`);
      for (const candidate of error.candidates) {
        console.error(`  ${candidate.recordId} (${candidate.source}/${candidate.role}/${candidate.status})`);
      }
    }
    process.exit(EXIT_CONFLICT);
  }

  if (error instanceof AgentSessionInspectNotFoundError) {
    if (opts.json) {
      console.error(JSON.stringify({
        error: {
          code: EXIT_NOT_FOUND,
          message: error.message,
          retryable: false,
          hint: 'Use "hydra session list --all --json" to see available agent session records.',
        },
      }));
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(EXIT_NOT_FOUND);
  }

  outputError(error, opts);
}
