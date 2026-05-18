import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, constants, accessSync } from 'fs';
import { join, delimiter } from 'path';
import { getHydraBinDir, getHydraConfigPath, getHydraHome } from '../../core/path';
import { type OutputOpts } from '../output';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function checkOnPath(cmd: string): boolean {
  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${lookupCmd} ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ghAuthenticated(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check prerequisites and diagnose common issues')
    .action(async () => {
      const globalOpts = program.opts() as OutputOpts;
      const checks: CheckResult[] = [];
      const hydraDir = getHydraHome();
      const hydraConfigPath = getHydraConfigPath();
      const hydraBinDir = getHydraBinDir();
      const hydraBin = join(hydraBinDir, process.platform === 'win32' ? 'hydra.cmd' : 'hydra');

      // 1. git
      checks.push(checkOnPath('git')
        ? { name: 'git', status: 'pass', message: 'git is installed' }
        : { name: 'git', status: 'fail', message: 'git not found — install from https://git-scm.com' });

      // 2. tmux (not available on Windows)
      if (process.platform !== 'win32') {
        checks.push(checkOnPath('tmux')
          ? { name: 'tmux', status: 'pass', message: 'tmux is installed' }
          : { name: 'tmux', status: 'fail', message: 'tmux not found — install with: brew install tmux' });
      }

      // 3. VS Code CLI
      checks.push(checkOnPath('code')
        ? { name: 'code', status: 'pass', message: 'VS Code CLI is installed' }
        : { name: 'code', status: 'fail', message: 'code CLI not found — install from https://code.visualstudio.com then run "Shell Command: Install code"' });

      // 4. Hydra home directory
      if (existsSync(hydraDir)) {
        checks.push({ name: 'hydra-home', status: 'pass', message: `Hydra home directory exists: ${hydraDir}` });
      } else {
        mkdirSync(hydraDir, { recursive: true });
        checks.push({ name: 'hydra-home', status: 'warn', message: `Hydra home was missing — created automatically at ${hydraDir}` });
      }

      // 5. Hydra config path
      if (existsSync(hydraConfigPath)) {
        checks.push({ name: 'hydra-config', status: 'pass', message: `Hydra config exists: ${hydraConfigPath}` });
      } else {
        checks.push({ name: 'hydra-config', status: 'warn', message: `Hydra config not found yet: ${hydraConfigPath}` });
      }

      // 6. Hydra CLI binary
      if (existsSync(hydraBin) && isExecutable(hydraBin)) {
        checks.push({ name: 'hydra-cli', status: 'pass', message: `Hydra CLI is installed at ${hydraBin}` });
      } else {
        if (!existsSync(hydraBinDir)) {
          mkdirSync(hydraBinDir, { recursive: true });
        }
        checks.push({ name: 'hydra-cli', status: 'fail', message: `Hydra CLI not found at ${hydraBin} — open VS Code with the Hydra extension installed to auto-install` });
      }

      // 7. Hydra bin in PATH
      const pathDirs = (process.env.PATH || '').split(delimiter);
      const binInPath = pathDirs.some(d => d === hydraBinDir);
      if (binInPath) {
        checks.push({ name: 'hydra-path', status: 'pass', message: `${hydraBinDir} is in PATH` });
      } else {
        const pathHint = process.platform === 'win32'
          ? `$env:PATH = "${hydraBinDir};$env:PATH"`
          : `export PATH="${hydraBinDir}:$PATH"`;
        checks.push({ name: 'hydra-path', status: 'warn', message: `${hydraBinDir} is not in PATH — add to your shell profile:\n    ${pathHint}` });
      }

      // 8. GitHub CLI
      checks.push(checkOnPath('gh')
        ? { name: 'gh', status: 'pass', message: 'GitHub CLI is installed' }
        : { name: 'gh', status: 'fail', message: 'gh not found — install from https://cli.github.com' });

      // 9. GitHub CLI authenticated
      if (checkOnPath('gh')) {
        checks.push(ghAuthenticated()
          ? { name: 'gh-auth', status: 'pass', message: 'GitHub CLI is authenticated' }
          : { name: 'gh-auth', status: 'fail', message: 'gh is not authenticated — run: gh auth login' });
      } else {
        checks.push({ name: 'gh-auth', status: 'fail', message: 'gh is not authenticated (gh not installed)' });
      }

      // 10. AI agent CLIs
      const agents = ['claude', 'codex', 'gemini', 'scode'];
      const foundAgents = agents.filter(a => checkOnPath(a));
      if (foundAgents.length > 0) {
        checks.push({ name: 'ai-agent', status: 'pass', message: `Found: ${foundAgents.join(', ')}` });
      } else {
        checks.push({ name: 'ai-agent', status: 'fail', message: 'No AI agent CLI found — install at least one of: claude, codex, gemini, scode' });
      }

      // Compute summary
      const passed = checks.filter(c => c.status === 'pass').length;
      const failed = checks.filter(c => c.status === 'fail').length;
      const warned = checks.filter(c => c.status === 'warn').length;
      const total = checks.length;

      // Output
      if (globalOpts.json) {
        console.log(JSON.stringify({ checks, passed, failed, warned }));
      } else if (!globalOpts.quiet) {
        console.log('\nHydra Doctor\n');
        for (const check of checks) {
          let icon: string;
          switch (check.status) {
            case 'pass': icon = `${GREEN}\u2714${RESET}`; break;
            case 'fail': icon = `${RED}\u2718${RESET}`; break;
            case 'warn': icon = `${YELLOW}\u26A0${RESET}`; break;
          }
          console.log(`  ${icon} ${check.name}: ${check.message}`);
        }
        console.log(`\n  ${passed}/${total} checks passed` +
          (warned > 0 ? `, ${warned} warning(s)` : '') +
          (failed > 0 ? `, ${failed} failed` : ''));
        console.log('');
      }

      // Exit code: 1 if any required checks fail, 0 otherwise (warnings are ok)
      process.exit(failed > 0 ? 1 : 0);
    });
}
