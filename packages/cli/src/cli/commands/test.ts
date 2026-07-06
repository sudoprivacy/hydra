import { Command } from 'commander';
import { runE2ETests, type TestReport } from '../../e2e/runner';
import { outputError, type OutputOpts } from '../output';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description('Run Hydra E2E scenario tests inside an isolated environment')
    .option('--filter <pattern>', 'Run only tests matching this substring')
    .option('--agent <type>', 'Force a specific agent CLI (claude, codex, gemini)')
    .action(async (opts: { filter?: string; agent?: string }) => {
      const globalOpts = program.opts() as OutputOpts;

      try {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log('\nHydra E2E Test Suite\n');
          console.log('\u2500'.repeat(60));
        }

        const report: TestReport = await runE2ETests({
          filter: opts.filter,
          agent: opts.agent,
        });

        if (globalOpts.json) {
          console.log(JSON.stringify(report));
        } else if (!globalOpts.quiet) {
          for (const result of report.results) {
            const duration = (result.durationMs / 1000).toFixed(1);
            if (result.passed) {
              console.log(`  ${GREEN}[PASS]${RESET} ${result.name} (${duration}s)`);
            } else {
              console.log(`  ${RED}[FAIL]${RESET} ${result.name}: ${result.error}`);
            }
          }

          if (report.total === 0) {
            console.log('  No tests matched the current filter.');
          }

          console.log('');
          console.log('\u2500'.repeat(60));
          const totalDuration = (report.durationMs / 1000).toFixed(1);
          console.log(`  Results: ${report.passed}/${report.total} passed, ${report.failed} failed (${totalDuration}s)`);
          console.log('');
        }

        process.exitCode = report.failed > 0 ? 1 : 0;
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
