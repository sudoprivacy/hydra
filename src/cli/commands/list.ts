import { Command } from 'commander';
import { TmuxBackendCore } from '../../core/tmux';
import { SessionManager } from '../../core/sessionManager';
import { resolveAgentSessionFile } from '../../core/path';
import { outputResult, outputError, type OutputOpts } from '../output';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all Hydra copilots and workers')
    .action(async () => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const state = await sm.sync();

        // Sort copilots and workers alphabetically by name for stability
        const copilots = Object.values(state.copilots)
          .sort((a, b) => (a.sessionName || a.tmuxSession).localeCompare(b.sessionName || b.tmuxSession));
        const workers = Object.values(state.workers);

        const data = {
          copilots: copilots.map(c => ({
            name: c.displayName || c.sessionName || c.tmuxSession,
            session: c.sessionName || c.tmuxSession,
            agent: c.agent,
            status: c.status,
            attached: c.attached,
            workdir: c.workdir || null,
            sessionId: c.sessionId,
            sessionFile: resolveAgentSessionFile(c.agent, c.workdir, c.sessionId, c.agentSessionFile),
            agentSessionId: c.sessionId,
          })),
          workers: workers.map(w => ({
            number: w.workerId,
            name: w.displayName || w.slug || w.sessionName || w.tmuxSession,
            session: w.sessionName || w.tmuxSession,
            repo: w.repo || null,
            branch: w.branch || null,
            agent: w.agent,
            status: w.status,
            attached: w.attached,
            workdir: w.workdir || null,
            copilotSessionName: w.copilotSessionName || null,
            sessionId: w.sessionId,
            sessionFile: resolveAgentSessionFile(w.agent, w.workdir, w.sessionId, w.agentSessionFile),
            agentSessionId: w.sessionId,
          })),
          count: copilots.length + workers.length,
        };

        outputResult(data, globalOpts, () => {
          const isTTY = process.stdout.isTTY;

          // Legend
          if (isTTY) {
            console.log('\n  \x1b[32m\u25CF\x1b[0m Running  \u25CB Stopped');
          }

          // Pretty-print copilots
          if (copilots.length > 0) {
            console.log('\nCopilots:');
            if (isTTY) console.log('\u2500'.repeat(60));
            for (const c of copilots) {
              const statusIcon = isTTY
                ? (c.status === 'running' ? '\x1b[32m\u25CF\x1b[0m' : '\u25CB')
                : `[${c.status}]`;
              const attached = c.attached ? ' (attached)' : '';
              const name = c.displayName || c.sessionName || c.tmuxSession;
              console.log(`  ${statusIcon} ${name}  [${c.agent}]${attached}`);
              if (c.workdir) console.log(`    workdir: ${c.workdir}`);
            }
          } else {
            console.log('\nNo copilots running.');
          }

          // Pretty-print workers (sorted alphabetically by name within each repo group)
          if (workers.length > 0) {
            console.log('\nWorkers:');
            if (isTTY) console.log('\u2500'.repeat(60));

            // Group by repo
            const byRepo = new Map<string, typeof workers>();
            for (const w of workers) {
              const key = w.repo || 'unknown';
              const group = byRepo.get(key) || [];
              group.push(w);
              byRepo.set(key, group);
            }

            // Sort repo groups alphabetically, sort workers within each group by name
            const sortedRepos = [...byRepo.keys()].sort((a, b) => a.localeCompare(b));
            for (const repo of sortedRepos) {
              const repoWorkers = byRepo.get(repo)!
                .sort((a, b) => (a.sessionName || a.tmuxSession).localeCompare(b.sessionName || b.tmuxSession));
              console.log(`  ${repo}:`);
              for (const w of repoWorkers) {
                const statusIcon = isTTY
                  ? (w.status === 'running' ? '\x1b[32m\u25CF\x1b[0m' : '\u25CB')
                  : `[${w.status}]`;
                const attached = w.attached ? ' (attached)' : '';
                const branch = w.branch ? ` (${w.branch})` : '';
                const name = w.displayName || w.slug || w.sessionName || w.tmuxSession;
                const num = w.workerId != null ? `#${w.workerId} ` : '';
                console.log(`    ${statusIcon} ${num}${name}${branch}  [${w.agent}]${attached}`);
                if (w.workdir) console.log(`      workdir: ${w.workdir}`);
              }
            }
          } else {
            console.log('\nNo workers.');
          }

          console.log('');
        });
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
