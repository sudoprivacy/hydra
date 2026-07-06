const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const providerPath = path.join(repoRoot, 'packages', 'extension', 'src', 'providers', 'tmuxSessionProvider.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');

assert.equal(
  providerSource.includes('git -C'),
  false,
  'tmuxSessionProvider.ts must not interpolate worktree paths into git -C shell commands'
);

if (process.platform === 'win32') {
  console.log('Skipping path injection smoke test: Windows paths cannot contain double quotes.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-shell-quoting-'));
const injectedDollar = path.join(tmp, 'injected-dollar');
const injectedBacktick = path.join(tmp, 'injected-backtick');
const env = { ...process.env, TMPDIR: `${tmp}${path.sep}` };

const maliciousRepoName = [
  'repo',
  '$(touch${IFS}${TMPDIR}injected-dollar)',
  '`touch${IFS}${TMPDIR}injected-backtick`',
  '"quoted"',
].join('-');
const maliciousRepoPath = path.join(tmp, maliciousRepoName);

try {
  fs.mkdirSync(maliciousRepoPath);
  execSync('git init -q', { cwd: maliciousRepoPath, env, stdio: 'ignore' });

  const commands = [
    'git symbolic-ref --short HEAD',
    'git rev-parse --short HEAD',
    'git status --porcelain',
    'git rev-list --count @{upstream}..HEAD',
    'git rev-parse --git-dir',
  ];

  for (const command of commands) {
    try {
      execSync(command, { cwd: maliciousRepoPath, env, stdio: 'ignore' });
    } catch {
      // Detached HEAD or missing upstream is acceptable here; command injection is not.
    }
  }

  assert.equal(fs.existsSync(injectedDollar), false, 'path containing $() executed a shell command');
  assert.equal(fs.existsSync(injectedBacktick), false, 'path containing backticks executed a shell command');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
