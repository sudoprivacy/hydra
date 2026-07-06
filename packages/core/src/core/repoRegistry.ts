import * as fs from 'fs';
import * as path from 'path';
import { exec } from './exec';
import { shellQuote } from './shell';
import { getHydraReposRoot, toCanonicalPath } from './path';
import { listWorktrees } from './git';

export interface ParsedRepoIdentifier {
  owner: string;
  name: string;
  /** Canonical "<owner>/<name>" string. */
  canonical: string;
  /** Clone URL used when fetching the repo. */
  cloneUrl: string;
}

export interface RegisteredRepo {
  owner: string;
  name: string;
  canonical: string;
  path: string;
  /** ISO timestamp of last `git fetch origin`, derived from .git/FETCH_HEAD mtime. */
  lastFetchedAt: string | null;
}

const SHORT_FORM_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const HTTPS_GITHUB_RE = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(\.git)?\/?$/;
const SSH_GITHUB_RE = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(\.git)?$/;

/**
 * Parse and normalize a repo identifier into <owner>/<name>.
 * Accepts:
 *   - <owner>/<name>
 *   - https://github.com/<owner>/<name>(.git)
 *   - git@github.com:<owner>/<name>(.git)
 *
 * GitHub-only for v1; non-GitHub URLs are rejected.
 */
export function parseRepoIdentifier(input: string): ParsedRepoIdentifier {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new Error('Repo identifier is required.');
  }

  let match = trimmed.match(SHORT_FORM_RE);
  if (match) return makeParsed(match[1], match[2]);

  match = trimmed.match(HTTPS_GITHUB_RE);
  if (match) return makeParsed(match[1], match[2]);

  match = trimmed.match(SSH_GITHUB_RE);
  if (match) return makeParsed(match[1], match[2]);

  throw new Error(
    `Could not parse repo identifier "${input}". ` +
    'Expected one of: <owner>/<name>, https://github.com/<owner>/<name>(.git), git@github.com:<owner>/<name>.git',
  );
}

/**
 * Path components that would either resolve outside the registry root
 * (`.`, `..`, any pure-dot string) or collide with git internals (`.git`).
 * Rejecting these closes a path-traversal hole: `parseRepoIdentifier("fake/..")`
 * would otherwise resolve `getRegistryRepoPath("fake", "..")` to the registry
 * root itself, and `add`/`remove` would operate on it.
 */
const UNSAFE_REPO_COMPONENTS = new Set(['.', '..', '.git']);

function isUnsafeRepoComponent(value: string): boolean {
  if (UNSAFE_REPO_COMPONENTS.has(value)) return true;
  if (/^\.+$/.test(value)) return true;
  return false;
}

function makeParsed(ownerRaw: string, nameRaw: string): ParsedRepoIdentifier {
  const owner = ownerRaw.trim();
  const name = nameRaw.replace(/\.git$/i, '').trim();
  if (!owner || !name) {
    throw new Error('Repo identifier owner and name must be non-empty.');
  }
  if (isUnsafeRepoComponent(owner) || isUnsafeRepoComponent(name)) {
    throw new Error(
      `Repo identifier "${owner}/${name}" contains an unsafe path component (".", "..", ".git" not allowed).`,
    );
  }
  return {
    owner,
    name,
    canonical: `${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  };
}

/** Filesystem path where the managed clone lives. */
export function getRegistryRepoPath(owner: string, name: string): string {
  return path.join(getHydraReposRoot(), owner, name);
}

/** A repo is registered iff its managed-clone directory exists with a .git. */
export function isRegisteredRepo(owner: string, name: string): boolean {
  const repoPath = getRegistryRepoPath(owner, name);
  return fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'));
}

/**
 * True when the path lives under ~/.hydra/repos/. Used to decide whether
 * to enforce auto-fetch before creating a worktree.
 */
export function isRegistryManagedPath(repoPath: string): boolean {
  const reposRoot = path.resolve(getHydraReposRoot());
  const candidate = path.resolve(repoPath);
  return candidate === reposRoot || candidate.startsWith(reposRoot + path.sep);
}

/**
 * Resolve a `--repo` argument to an absolute repo path on disk.
 *
 *   <owner>/<name>     → ~/.hydra/repos/<owner>/<name>/ (must be registered)
 *   <abs-path>         → returned unchanged (backward compat for existing clones)
 *   <git URL>          → throws — caller must run `hydra repo add` first
 *
 * NOTE: this helper does NOT route relative paths like `.` or `./foo`. Use
 * resolveRepoInput() for end-to-end CLI dispatch (path vs identifier).
 */
export function resolveRepoIdentifier(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new Error('--repo is required.');
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  if (/^(https?:|git@)/i.test(trimmed)) {
    throw new Error(
      `Pass <owner>/<name> after running hydra repo add ${trimmed} first.`,
    );
  }

  const parsed = parseRepoIdentifier(trimmed);
  if (!isRegisteredRepo(parsed.owner, parsed.name)) {
    throw new Error(
      `Repo ${parsed.canonical} is not registered. Run: hydra repo add ${parsed.canonical}`,
    );
  }
  return getRegistryRepoPath(parsed.owner, parsed.name);
}

/**
 * Decide whether a `--repo` value is a filesystem path or a registry identifier.
 *
 * Path-like (skip registry parsing, just expand to absolute):
 *   - absolute paths (`/foo`, `\\server\share`)
 *   - home-relative (`~`, `~/foo`)
 *   - explicit relatives (`.`, `..`, `./foo`, `../foo`, `.\\foo`, `..\\foo`)
 *   - dotfile/dotdir prefixes (`.foo` — treated as path so `--repo .` etc. keep working)
 *   - Windows drive letters (`C:\\foo`, `D:/bar`)
 *
 * Everything else is treated as a registry identifier (short form / URL).
 *
 * This rule is what makes the legacy `hydra worker create --repo . --branch foo`
 * flow keep working alongside the new short-form `--repo sudoprivacy/hydra`.
 */
export function looksLikePathInput(input: string): boolean {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('.')) return true;
  if (trimmed.startsWith('/')) return true;
  if (trimmed.startsWith('\\')) return true;
  if (trimmed.startsWith('~')) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return false;
}

export interface ResolvedRepoInput {
  /** Absolute filesystem path the input resolved to. */
  path: string;
  /** True iff path lives under ~/.hydra/repos/ (caller should require fetch). */
  isManaged: boolean;
}

/**
 * Single dispatch point for `--repo` arguments shared by worker and copilot
 * create. Routes path-like inputs straight to `path.resolve` and registry
 * identifiers through `resolveRepoIdentifier`.
 */
export function resolveRepoInput(input: string): ResolvedRepoInput {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new Error('--repo is required.');
  }

  let resolvedPath: string;
  if (looksLikePathInput(trimmed)) {
    resolvedPath = toCanonicalPath(trimmed) || path.resolve(trimmed);
  } else {
    resolvedPath = resolveRepoIdentifier(trimmed);
  }

  return {
    path: resolvedPath,
    isManaged: isRegistryManagedPath(resolvedPath),
  };
}

export interface AddRepoOptions {
  /**
   * Override the clone URL git will fetch from. Used by tests to drive against
   * a local file:// origin so the smoke test can exercise the real clone path
   * without network. Production callers must leave this unset — the canonical
   * GitHub URL derived from <owner>/<name> is the right thing for users.
   */
  cloneUrl?: string;
}

/**
 * Clone <owner>/<name> into ~/.hydra/repos/<owner>/<name>/ if not already present.
 * Idempotent: if the clone target already exists, returns alreadyExisted=true.
 *
 * On clone failure, removes any partial directory git left behind so the next
 * `repo add` call doesn't trip over "destination path ... already exists and
 * is not empty".
 */
export async function addRepo(
  input: string,
  opts: AddRepoOptions = {},
): Promise<{ parsed: ParsedRepoIdentifier; path: string; alreadyExisted: boolean }> {
  const parsed = parseRepoIdentifier(input);
  const repoPath = getRegistryRepoPath(parsed.owner, parsed.name);

  if (isRegisteredRepo(parsed.owner, parsed.name)) {
    return { parsed, path: repoPath, alreadyExisted: true };
  }

  const ownerDir = path.dirname(repoPath);
  fs.mkdirSync(ownerDir, { recursive: true });

  const cloneUrl = opts.cloneUrl || parsed.cloneUrl;

  try {
    await exec(
      `git clone ${shellQuote(cloneUrl)} ${shellQuote(repoPath)}`,
    );
  } catch (error) {
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup. The original error is what the caller cares about.
    }
    throw error;
  }

  return { parsed, path: repoPath, alreadyExisted: false };
}

/** `git fetch origin` inside the managed clone. */
export async function fetchRepo(owner: string, name: string): Promise<{ path: string }> {
  const repoPath = getRegistryRepoPath(owner, name);
  if (!isRegisteredRepo(owner, name)) {
    throw new Error(`Repo ${owner}/${name} is not registered.`);
  }
  await exec('git fetch origin', { cwd: repoPath });
  return { path: repoPath };
}

/** Fetch every registered repo. Best-effort: failures are reported but don't abort. */
export async function fetchAllRepos(): Promise<{ ok: RegisteredRepo[]; failed: { repo: RegisteredRepo; error: string }[] }> {
  const repos = listRegisteredRepos();
  const ok: RegisteredRepo[] = [];
  const failed: { repo: RegisteredRepo; error: string }[] = [];
  for (const repo of repos) {
    try {
      await exec('git fetch origin', { cwd: repo.path });
      ok.push(repo);
    } catch (error) {
      failed.push({ repo, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok, failed };
}

export function listRegisteredRepos(): RegisteredRepo[] {
  const root = getHydraReposRoot();
  if (!fs.existsSync(root)) return [];

  const out: RegisteredRepo[] = [];
  for (const ownerEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerPath = path.join(root, ownerEntry.name);

    let nameEntries: fs.Dirent[];
    try {
      nameEntries = fs.readdirSync(ownerPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const nameEntry of nameEntries) {
      if (!nameEntry.isDirectory()) continue;
      const repoPath = path.join(ownerPath, nameEntry.name);
      if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
      out.push({
        owner: ownerEntry.name,
        name: nameEntry.name,
        canonical: `${ownerEntry.name}/${nameEntry.name}`,
        path: repoPath,
        lastFetchedAt: readFetchHeadMtime(repoPath),
      });
    }
  }
  out.sort((a, b) => a.canonical.localeCompare(b.canonical));
  return out;
}

function readFetchHeadMtime(repoPath: string): string | null {
  const fetchHead = path.join(repoPath, '.git', 'FETCH_HEAD');
  try {
    const stat = fs.statSync(fetchHead);
    return new Date(stat.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * True when the managed clone has active worktrees beyond the clone itself.
 *
 * A fresh `git clone` produces exactly one worktree (its own root), so any
 * count greater than one means the user has spawned workers off this repo.
 * We deliberately don't compare against `isMain` here: on macOS, `git
 * worktree list` reports `/private/var/...` realpaths while our normalized
 * comparison stays on the symlinked `/var/...` form, so the flag isn't
 * reliable enough to gate destructive removal.
 */
export async function repoHasWorktrees(repoPath: string): Promise<boolean> {
  const worktrees = await listWorktrees(repoPath);
  return worktrees.length > 1;
}

export interface RemoveRepoOpts {
  force?: boolean;
}

export async function removeRepo(
  input: string,
  opts: RemoveRepoOpts = {},
): Promise<{ canonical: string; path: string }> {
  const parsed = parseRepoIdentifier(input);
  const repoPath = getRegistryRepoPath(parsed.owner, parsed.name);

  if (!isRegisteredRepo(parsed.owner, parsed.name)) {
    throw new Error(`Repo ${parsed.canonical} is not registered.`);
  }

  if (!opts.force && (await repoHasWorktrees(repoPath))) {
    throw new Error(
      `Repo ${parsed.canonical} still has active worktrees. ` +
      'Delete those workers first (hydra worker delete <session>), or pass --force to remove anyway.',
    );
  }

  fs.rmSync(repoPath, { recursive: true, force: true });

  // Best-effort cleanup of an empty owner directory.
  const ownerDir = path.dirname(repoPath);
  try {
    if (fs.readdirSync(ownerDir).length === 0) {
      fs.rmdirSync(ownerDir);
    }
  } catch {
    // best-effort
  }

  return { canonical: parsed.canonical, path: repoPath };
}
