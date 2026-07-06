import * as readline from 'readline';
import { Command } from 'commander';
import {
  addRepo,
  fetchAllRepos,
  fetchRepo,
  listRegisteredRepos,
  parseRepoIdentifier,
  removeRepo,
} from '../../core/repoRegistry';
import { outputResult, outputError, type OutputOpts } from '../output';

interface GlobalOpts extends OutputOpts {
  interactive?: boolean;
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise(resolve => rl.question(`${message} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerRepoCommands(program: Command): void {
  const repo = program
    .command('repo')
    .description('Manage centrally-cloned repositories under ~/.hydra/repos/');

  repo
    .command('add <identifier>')
    .description('Clone a repo into ~/.hydra/repos/<owner>/<name>/ (no-op if already present)')
    .action(async (identifier: string) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const result = await addRepo(identifier);
        outputResult(
          {
            status: result.alreadyExisted ? 'exists' : 'added',
            owner: result.parsed.owner,
            name: result.parsed.name,
            canonical: result.parsed.canonical,
            path: result.path,
          },
          globalOpts,
          () => {
            const verb = result.alreadyExisted ? 'Already registered' : 'Registered';
            console.log(`${verb}: ${result.parsed.canonical}`);
            console.log(`  Path: ${result.path}`);
            if (result.alreadyExisted) {
              console.log('  (run `hydra repo fetch ' + result.parsed.canonical + '` to refresh)');
            }
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  repo
    .command('list')
    .description('List registered repos')
    .action(async () => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const repos = listRegisteredRepos();
        outputResult(
          { repos, count: repos.length },
          globalOpts,
          () => {
            if (repos.length === 0) {
              console.log('No repos registered. Run: hydra repo add <owner>/<name>');
              return;
            }
            console.log('Registered repos:');
            for (const r of repos) {
              const fetched = r.lastFetchedAt ? r.lastFetchedAt : 'never';
              console.log(`  ${r.canonical}`);
              console.log(`    Path:          ${r.path}`);
              console.log(`    Last fetched:  ${fetched}`);
            }
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  repo
    .command('remove <identifier>')
    .description('Delete the managed clone (refuses if any worktrees exist; --force to override)')
    .option('--force', 'Remove even when worktrees exist')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (identifier: string, opts: { force?: boolean; yes?: boolean }) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const parsed = parseRepoIdentifier(identifier);

        const interactive = globalOpts.interactive !== false && process.stdin.isTTY;
        if (!opts.yes && !globalOpts.json) {
          if (interactive) {
            const ok = await confirm(`Remove managed clone for ${parsed.canonical}?`);
            if (!ok) {
              outputResult(
                { status: 'cancelled', canonical: parsed.canonical },
                globalOpts,
                () => console.log('Cancelled.'),
              );
              return;
            }
          } else {
            // --no-interactive lands here too (it's what flips `interactive` to
            // false on a non-TTY), so don't recommend it back to the user.
            throw new Error(
              'Refusing to remove without confirmation. Pass --yes to proceed.',
            );
          }
        }

        const result = await removeRepo(identifier, { force: opts.force });
        outputResult(
          { status: 'removed', canonical: result.canonical, path: result.path },
          globalOpts,
          () => {
            console.log(`Removed: ${result.canonical}`);
            console.log(`  Path: ${result.path}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  repo
    .command('fetch [identifier]')
    .description('Run `git fetch origin` in the managed clone (use --all for every repo)')
    .option('--all', 'Fetch every registered repo')
    .action(async (identifier: string | undefined, opts: { all?: boolean }) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        if (opts.all) {
          const result = await fetchAllRepos();
          outputResult(
            {
              status: 'fetched',
              fetched: result.ok.map(r => r.canonical),
              failed: result.failed.map(f => ({ canonical: f.repo.canonical, error: f.error })),
            },
            globalOpts,
            () => {
              for (const r of result.ok) console.log(`  fetched: ${r.canonical}`);
              for (const f of result.failed) console.log(`  failed:  ${f.repo.canonical}: ${f.error}`);
              if (result.ok.length === 0 && result.failed.length === 0) {
                console.log('No repos registered.');
              }
            },
          );
          return;
        }

        if (!identifier) {
          throw new Error('Pass <owner>/<name> or use --all.');
        }

        const parsed = parseRepoIdentifier(identifier);
        const { path: repoPath } = await fetchRepo(parsed.owner, parsed.name);
        outputResult(
          { status: 'fetched', canonical: parsed.canonical, path: repoPath },
          globalOpts,
          () => console.log(`Fetched: ${parsed.canonical}`),
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
