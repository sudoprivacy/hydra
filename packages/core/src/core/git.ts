import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { exec } from './exec';
import { getHydraWorktreesRoot, toCanonicalPath } from './path';
import { shellQuote } from './shell';
import { MultiplexerBackendCore, Worktree } from './types';

export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    await exec(`git -C ${shellQuote(dirPath)} rev-parse --git-dir`);
    return true;
  } catch {
    return false;
  }
}

export async function findGitReposInDir(parentDir: string): Promise<{ name: string; path: string }[]> {
  const repos: { name: string; path: string }[] = [];
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const childPath = path.join(parentDir, entry.name);
      if (await isGitRepo(childPath)) {
        repos.push({ name: entry.name, path: childPath });
      }
    }
  } catch {
    // parent dir not readable
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateBranchName(branchName: string): string | undefined {
  const trimmedBranch = branchName.trim();

  if (!trimmedBranch) {
    return 'Branch name is required.';
  }
  if (/\s/.test(trimmedBranch)) {
    return 'Branch names cannot contain whitespace.';
  }
  if (trimmedBranch === '@') {
    return 'Branch name "@" is not allowed.';
  }
  if (trimmedBranch.startsWith('-')) {
    return 'Branch names cannot start with "-".';
  }
  if (trimmedBranch.startsWith('/') || trimmedBranch.endsWith('/')) {
    return 'Branch names cannot start or end with "/".';
  }
  if (trimmedBranch.endsWith('.')) {
    return 'Branch names cannot end with ".".';
  }
  if (trimmedBranch.endsWith('.lock')) {
    return 'Branch names cannot end with ".lock".';
  }
  if (trimmedBranch.includes('..')) {
    return 'Branch names cannot contain "..".';
  }
  if (trimmedBranch.includes('//')) {
    return 'Branch names cannot contain "//".';
  }
  if (trimmedBranch.includes('@{')) {
    return 'Branch names cannot contain "@{".';
  }
  if (/[~^:?*\\]/.test(trimmedBranch) || trimmedBranch.includes('[')) {
    return 'Branch names contain invalid characters.';
  }
  if (Array.from(trimmedBranch).some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    return 'Branch names cannot contain control characters.';
  }

  return undefined;
}

export function branchNameToSlug(branchName: string, backend: MultiplexerBackendCore): string {
  return backend.sanitizeSessionName(branchName.trim());
}

export function getRepoName(repoRoot: string): string {
  return path.basename(repoRoot);
}

export function getRepoSessionNamespace(repoRoot: string, backend: MultiplexerBackendCore): string {
  const canonicalRoot = toCanonicalPath(repoRoot) || path.resolve(repoRoot);
  const repoName = backend.sanitizeSessionName(path.basename(canonicalRoot) || 'repo');
  const rootHash = createHash('sha1').update(canonicalRoot).digest('hex').slice(0, 8);
  return `${repoName}-${rootHash}`;
}

// Use double quotes around the git --format spec, not single. cmd.exe on
// Windows does not strip single quotes, so they would be passed through to git
// verbatim and every emitted ref would be wrapped in literal '…' — making the
// equality check below silently fail for every branch. See issue #225 §1.
export function buildListLocalBranchesCommand(): string {
  return 'git for-each-ref --format="%(refname:short)" refs/heads';
}

export async function localBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    const output = await exec(buildListLocalBranchesCommand(), { cwd: repoRoot });
    return output.split('\n').some(line => line.trim() === branchName);
  } catch {
    return false;
  }
}

export function getManagedWorktreesRoot(): string {
  return getHydraWorktreesRoot();
}

/**
 * Derive a filesystem-safe repo identifier: <basename>-<sha1(canonicalPath)[0:8]>
 */
export function getRepoIdentifier(repoRoot: string): string {
  const canonicalRoot = toCanonicalPath(repoRoot) || path.resolve(repoRoot);
  const basename = path.basename(canonicalRoot) || 'repo';
  // Sanitize basename for filesystem safety (keep alphanumeric, hyphens, underscores)
  const safeName = basename.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  const rootHash = createHash('sha1').update(canonicalRoot).digest('hex').slice(0, 8);
  return `${safeName}-${rootHash}`;
}

export function getManagedRepoWorktreesDir(repoRoot: string): string {
  return path.join(getManagedWorktreesRoot(), getRepoIdentifier(repoRoot));
}

/** Legacy location inside the repo: <repo>/.hydra/worktrees/ */
export function getInRepoWorktreesDir(repoRoot: string): string {
  return path.join(repoRoot, '.hydra', 'worktrees');
}

/** Legacy location under ~/.tmux-worktrees/<namespace>/ */
export function getLegacyTmuxWorktreesDir(repoRoot: string, backend: MultiplexerBackendCore): string {
  return path.join(os.homedir(), '.tmux-worktrees', getRepoSessionNamespace(repoRoot, backend));
}

/** @deprecated Use getLegacyTmuxWorktreesDir instead */
export function getLegacyManagedRepoWorktreesDir(repoRoot: string, backend: MultiplexerBackendCore): string {
  return getLegacyTmuxWorktreesDir(repoRoot, backend);
}

export function isManagedWorktreePath(repoRoot: string, worktreePath: string, backend?: MultiplexerBackendCore): boolean {
  const candidatePath = toCanonicalPath(worktreePath);
  if (!candidatePath) return false;

  const isUnder = (dir: string | undefined) =>
    dir && (candidatePath === dir || candidatePath.startsWith(`${dir}${path.sep}`));

  // Check current location: ~/.hydra/worktrees/<repo-identifier>/
  if (isUnder(toCanonicalPath(getManagedRepoWorktreesDir(repoRoot)))) {
    return true;
  }

  // Check legacy in-repo location: <repo>/.hydra/worktrees/
  if (isUnder(toCanonicalPath(getInRepoWorktreesDir(repoRoot)))) {
    return true;
  }

  // Check legacy ~/.tmux-worktrees/<namespace>/
  if (backend) {
    if (isUnder(toCanonicalPath(getLegacyTmuxWorktreesDir(repoRoot, backend)))) {
      return true;
    }
  }

  return false;
}

export async function ensureWorktreesDir(repoRoot: string): Promise<string> {
  const worktreesDir = getManagedRepoWorktreesDir(repoRoot);
  if (!fs.existsSync(worktreesDir)) {
    await fs.promises.mkdir(worktreesDir, { recursive: true });
  }

  // Write .repo-root marker so we can discover the repo root from a worktree path
  const markerPath = path.join(worktreesDir, '.repo-root');
  const canonicalRoot = toCanonicalPath(repoRoot) || path.resolve(repoRoot);
  try {
    fs.writeFileSync(markerPath, canonicalRoot, 'utf-8');
  } catch {
    // ignore marker write errors
  }

  return worktreesDir;
}

/**
 * Resolve repo root from a worktree path by reading the .repo-root marker.
 * Works for worktrees at ~/.hydra/worktrees/<repo-id>/<slug>.
 * Returns undefined if not resolvable.
 */
export function resolveRepoRootFromWorktreePath(worktreePath: string): string | undefined {
  // New location: ~/.hydra/worktrees/<repo-id>/<slug> → parent has .repo-root
  const parent = path.dirname(worktreePath);
  const markerPath = path.join(parent, '.repo-root');
  try {
    if (fs.existsSync(markerPath)) {
      return fs.readFileSync(markerPath, 'utf-8').trim();
    }
  } catch {
    // fall through
  }

  // Legacy in-repo location: <repo>/.hydra/worktrees/<slug>
  const hydraIdx = worktreePath.indexOf(`${path.sep}.hydra${path.sep}worktrees${path.sep}`);
  if (hydraIdx >= 0) {
    return worktreePath.substring(0, hydraIdx);
  }

  return undefined;
}

async function getMainWorktreePath(repoRoot: string): Promise<string> {
  try {
    const commonDirRaw = await exec('git rev-parse --git-common-dir', { cwd: repoRoot });
    const commonDir = commonDirRaw.trim();
    if (!commonDir) return repoRoot;

    const resolvedCommonDir = path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(repoRoot, commonDir);

    return path.dirname(resolvedCommonDir);
  } catch {
    return repoRoot;
  }
}

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  try {
    const output = await exec('git worktree list --porcelain', { cwd: repoRoot });
    const worktrees: Worktree[] = [];
    const blocks = output.split('\n\n').filter(b => b.trim());
    const mainWorktreePath = await getMainWorktreePath(repoRoot);
    const normalizedMainWorktreePath = toCanonicalPath(mainWorktreePath) || path.resolve(mainWorktreePath);

    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let branch = '';
      let isPrunable = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.substring(9);
        } else if (line.startsWith('branch ')) {
          const ref = line.substring(7);
          if (ref.startsWith('refs/heads/')) {
            branch = ref.substring('refs/heads/'.length);
          } else if (ref.startsWith('refs/remotes/')) {
            branch = ref.substring('refs/remotes/'.length);
          } else {
            branch = ref;
          }
        } else if (line === 'prunable') {
          isPrunable = true;
        }
      }

      if (wtPath && !isPrunable) {
        const normalizedPath = toCanonicalPath(wtPath) || path.resolve(wtPath);
        worktrees.push({
          path: wtPath,
          branch,
          isMain: normalizedPath === normalizedMainWorktreePath
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

export async function getWorktreeBranch(repoRoot: string, worktreePath: string): Promise<string | undefined> {
  const normalizedCandidatePath = toCanonicalPath(worktreePath) || path.resolve(worktreePath);
  const worktrees = await listWorktrees(repoRoot);
  return worktrees.find(worktree => {
    const normalizedPath = toCanonicalPath(worktree.path) || path.resolve(worktree.path);
    return normalizedPath === normalizedCandidatePath;
  })?.branch;
}

export async function isSlugTaken(
  slug: string,
  repoSessionNamespace: string,
  repoRoot: string,
  backend: MultiplexerBackendCore
): Promise<boolean> {
  const worktreesDir = await ensureWorktreesDir(repoRoot);
  const candidatePath = path.join(worktreesDir, slug);
  const normalizedCandidatePath = toCanonicalPath(candidatePath) || path.resolve(candidatePath);

  // 1. Existing worktree path, reserved primary slug, or leftover directory
  const worktrees = await listWorktrees(repoRoot);
  const worktreePathExists = worktrees.some(worktree => {
    const normalizedPath = toCanonicalPath(worktree.path) || path.resolve(worktree.path);
    return normalizedPath === normalizedCandidatePath;
  });
  const reservedPrimarySlug = backend.sanitizeSessionName(slug) === backend.sanitizeSessionName('main') &&
    worktrees.some(worktree => worktree.isMain);
  if (worktreePathExists || reservedPrimarySlug || fs.existsSync(candidatePath)) return true;

  // 2. Check sessions
  try {
    const existingSessions = await backend.listSessions();
    const sessionName = backend.buildSessionName(repoSessionNamespace, slug);
    return existingSessions.some(s => s.name === sessionName);
  } catch {
    return false;
  }
}

export async function addWorktree(
  repoRoot: string,
  branchName: string,
  slug: string,
  baseBranch: string
): Promise<string> {
  const worktreesDir = await ensureWorktreesDir(repoRoot);
  const worktreePath = path.join(worktreesDir, slug);

  await exec(
    `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branchName)} ${shellQuote(baseBranch)}`,
    { cwd: repoRoot }
  );

  // Store base branch for VS Code SCM diff anchoring
  await exec(
    `git config ${shellQuote(`branch.${branchName}.vscode-merge-base`)} ${shellQuote(baseBranch)}`,
    { cwd: repoRoot }
  );

  return worktreePath;
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await exec(`git worktree remove ${shellQuote(worktreePath)} --force`, { cwd: repoRoot });
}

/** Fetch latest refs from origin. Best-effort — returns silently on failure. */
export async function fetchOrigin(repoRoot: string): Promise<void> {
  try {
    await exec('git fetch origin', { cwd: repoRoot });
  } catch {
    // Network unavailable or no remote — proceed with local state
  }
}

/** Fetch latest refs from origin. Throws on failure (used for registry-managed repos). */
export async function fetchOriginRequired(repoRoot: string): Promise<void> {
  await exec('git fetch origin', { cwd: repoRoot });
}

/**
 * Check if the local base branch has commits ahead of its remote counterpart.
 * Returns the count of local-only commits, or 0 if not applicable.
 */
export async function getLocalAheadCount(repoRoot: string, baseBranch: string): Promise<number> {
  // Determine local and remote refs to compare
  let localRef: string;
  let remoteRef: string;

  if (baseBranch.startsWith('origin/')) {
    // baseBranch is already a remote ref — compare against local equivalent
    localRef = baseBranch.replace(/^origin\//, '');
    remoteRef = baseBranch;
  } else {
    localRef = baseBranch;
    remoteRef = `origin/${baseBranch}`;
  }

  try {
    // Verify both refs exist
    await exec(`git rev-parse --verify ${shellQuote(localRef)}`, { cwd: repoRoot });
    await exec(`git rev-parse --verify ${shellQuote(remoteRef)}`, { cwd: repoRoot });

    const count = await exec(
      `git rev-list --count ${shellQuote(remoteRef)}..${shellQuote(localRef)}`,
      { cwd: repoRoot },
    );
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/** Determine base branch without vscode config — tries common candidates. */
export async function getBaseBranchFromRepo(repoRoot: string, override?: string): Promise<string> {
  if (override) {
    try {
      await exec(`git rev-parse --verify ${shellQuote(override)}`, { cwd: repoRoot });
      return override;
    } catch {
      throw new Error(`Configured baseBranch "${override}" not found in repository`);
    }
  }

  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  for (const candidate of candidates) {
    try {
      await exec(`git rev-parse --verify ${shellQuote(candidate)}`, { cwd: repoRoot });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error('No default branch found (tried: origin/main, main, origin/master, master)');
}

/** Get repo root from a path by running git rev-parse */
export async function getRepoRootFromPath(dirPath: string): Promise<string> {
  return exec('git rev-parse --show-toplevel', { cwd: dirPath });
}
