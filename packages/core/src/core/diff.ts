// Headless diff service — the vscode-free port of the extension's
// `reviewChanges.ts` git logic. It answers two questions for a worker workdir:
//
//   1. getDiff(workdir)        — what changed since the review base ref?
//   2. getFileSnapshot(...)    — the contents of one changed file, on the
//                                base or the working-tree side.
//
// Both are consumed by the desktop app through `HydraAppService.getDiff` /
// `getFileSnapshot`. Keeping the git logic here (alongside `git.ts`) means the
// CLI, the extension, the sidecar, and a future `hydrad` share one
// implementation and one base-ref chain.
//
// SECURITY: `getFileSnapshot` is path-constrained. The caller supplies a path
// relative to the (trusted) session workdir; this module resolves it *within*
// that workdir and rejects absolute paths and `..` escapes, so a renderer
// payload can never read an arbitrary file. See FINAL.md §"Security posture".

import { execFile as execFileCallback } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { resolveCommandPath } from './exec';

const execFile = promisify(execFileCallback);

// Match the extension's ceiling so large worktrees behave identically.
const MAX_GIT_OUTPUT = 50 * 1024 * 1024;
export const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024;

// The base-ref candidate chain, in priority order, after the branch-configured
// `branch.<name>.vscode-merge-base`. Identical to `reviewChanges.ts` so the
// desktop diff anchors exactly where the VS Code SCM diff does.
const BASE_REF_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master'];

export type DiffSide = 'base' | 'current';

export interface DiffChange {
  /** Raw git `--name-status` code: `A`, `M`, `D`, `R100`, `C75`, … */
  status: string;
  /** New path (post-rename), relative to the workdir. */
  path: string;
  /** Original path for renames/copies, relative to the workdir. */
  oldPath?: string;
}

export interface DiffResult {
  /** The ref the diff is anchored against (e.g. `origin/main`). */
  baseRef: string;
  /** The merge-base commit of baseRef and HEAD, or baseRef if none. */
  baseCommit: string;
  /** Current branch name, or empty string in detached HEAD. */
  branch: string;
  /** Changed files since baseCommit, plus untracked, sorted by path. */
  changes: DiffChange[];
}

export interface FileSnapshotResult {
  /** Path relative to the workdir, as requested. */
  path: string;
  side: DiffSide;
  /** The ref the base side was read from (undefined for the current side). */
  ref?: string;
  /** File contents, or empty string when the file does not exist on that side. */
  content: string;
  /** Whether the file exists on the requested side. */
  exists: boolean;
}

export interface BoundedSnapshotReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
}

interface ExecFileFailure extends Error {
  code?: string | number;
}

export class DiffService {
  private gitBinary: string | undefined;

  constructor(gitBinaryOverride?: string) {
    this.gitBinary = gitBinaryOverride;
  }

  /** Changed files for a worker workdir, anchored on the review base ref. */
  async getDiff(workdir: string): Promise<DiffResult> {
    const baseRef = await this.getReviewBaseRef(workdir);
    const baseCommit = await this.getMergeBase(workdir, baseRef);
    const branch = await this.getCurrentBranch(workdir);
    const changes = await this.getReviewChanges(workdir, baseCommit);
    return { baseRef, baseCommit, branch, changes };
  }

  /**
   * Contents of one changed file on the requested side.
   * `relPath` MUST be relative to `workdir`; absolute paths and `..` escapes
   * are rejected before any filesystem or git access.
   */
  async getFileSnapshot(
    workdir: string,
    relPath: string,
    side: DiffSide = 'current',
  ): Promise<FileSnapshotResult> {
    const safeAbsolutePath = resolveWithinWorkdir(workdir, relPath);
    const normalizedRelPath = path.relative(path.resolve(workdir), safeAbsolutePath);

    if (side === 'current') {
      const content = await readCurrentSnapshot(path.resolve(workdir), safeAbsolutePath, relPath);
      return {
        path: normalizedRelPath,
        side,
        content: content ?? '',
        exists: content !== undefined,
      };
    }

    const baseRef = await this.getReviewBaseRef(workdir);
    const baseCommit = await this.getMergeBase(workdir, baseRef);
    // `git show <commit>:<path>` needs a repo-relative, forward-slash path.
    const gitPath = normalizedRelPath.split(path.sep).join('/');
    const treeEntry = await this.tryGit(['ls-tree', '-z', baseCommit, '--', gitPath], workdir);
    if (!treeEntry.ok || !treeEntry.output) {
      return {
        path: normalizedRelPath,
        side,
        ref: baseCommit,
        content: '',
        exists: false,
      };
    }
    const mode = treeEntry.output.slice(0, treeEntry.output.indexOf(' '));
    if (mode !== '100644' && mode !== '100755') {
      throw new Error(`File snapshot is not a regular file: ${relPath}`);
    }
    const object = `${baseCommit}:${gitPath}`;
    const type = await this.tryGit(['cat-file', '-t', object], workdir);
    if (!type.ok) {
      return {
        path: normalizedRelPath,
        side,
        ref: baseCommit,
        content: '',
        exists: false,
      };
    }
    if (type.output.trim() !== 'blob') {
      throw new Error(`File snapshot is not a regular file: ${relPath}`);
    }
    const size = Number.parseInt((await this.git(['cat-file', '-s', object], workdir)).trim(), 10);
    assertSnapshotSize(size, relPath);
    const shown = await this.gitBuffer(['show', object], workdir, MAX_FILE_SNAPSHOT_BYTES + 1);
    assertTextSnapshot(shown, relPath);
    return {
      path: normalizedRelPath,
      side,
      ref: baseCommit,
      content: shown.toString('utf8'),
      exists: true,
    };
  }

  // ── git plumbing (ported verbatim in spirit from reviewChanges.ts) ──

  private async getReviewBaseRef(workdir: string): Promise<string> {
    const isWorktree = (await this.git(['rev-parse', '--is-inside-work-tree'], workdir)).trim();
    if (isWorktree !== 'true') {
      throw new Error(`Not a git worktree: ${workdir}`);
    }

    const branch = await this.getCurrentBranch(workdir);
    if (branch) {
      const configured = (await this.tryGitOutput(
        ['config', '--get', `branch.${branch}.vscode-merge-base`],
        workdir,
      )).trim();
      if (configured && await this.refExists(workdir, configured)) {
        return configured;
      }
    }

    for (const candidate of BASE_REF_CANDIDATES) {
      if (await this.refExists(workdir, candidate)) {
        return candidate;
      }
    }

    const suffix = branch ? ` on branch "${branch}"` : '';
    throw new Error(`Unable to find a base branch for this worktree${suffix}: ${workdir}`);
  }

  private async getMergeBase(workdir: string, baseRef: string): Promise<string> {
    const mergeBase = (await this.tryGitOutput(['merge-base', baseRef, 'HEAD'], workdir)).trim();
    return mergeBase || baseRef;
  }

  private async getReviewChanges(workdir: string, baseCommit: string): Promise<DiffChange[]> {
    const tracked = parseNameStatus(
      await this.tryGitOutput(['diff', '--name-status', '--find-renames', '-z', baseCommit, '--'], workdir),
    );
    const seen = new Set(tracked.map(change => change.path));

    const untracked = splitNul(
      await this.tryGitOutput(['ls-files', '--others', '--exclude-standard', '-z'], workdir),
    );
    for (const filePath of untracked) {
      if (!seen.has(filePath)) {
        tracked.push({ status: 'A', path: filePath });
        seen.add(filePath);
      }
    }

    return tracked.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async getCurrentBranch(workdir: string): Promise<string> {
    return (await this.tryGitOutput(['branch', '--show-current'], workdir)).trim();
  }

  private async refExists(workdir: string, ref: string): Promise<boolean> {
    return Boolean((await this.tryGitOutput(['rev-parse', '--verify', `${ref}^{commit}`], workdir)).trim());
  }

  // ── exec helpers ──

  private async getGitBinary(): Promise<string> {
    if (this.gitBinary) {
      return this.gitBinary;
    }
    this.gitBinary = (await resolveCommandPath('git')) || 'git';
    return this.gitBinary;
  }

  /** Run git, throwing on failure. Retries once past a stale cached binary. */
  private async git(args: string[], cwd: string): Promise<string> {
    const binary = await this.getGitBinary();
    try {
      const { stdout } = await execFile(binary, args, { cwd, maxBuffer: MAX_GIT_OUTPUT });
      return stdout.toString();
    } catch (error) {
      const failure = error as ExecFileFailure;
      if (failure.code !== 'ENOENT') {
        throw error;
      }
      this.gitBinary = undefined;
      const { stdout } = await execFile(await this.getGitBinary(), args, { cwd, maxBuffer: MAX_GIT_OUTPUT });
      return stdout.toString();
    }
  }

  private async gitBuffer(args: string[], cwd: string, maxBuffer: number): Promise<Buffer> {
    const binary = await this.getGitBinary();
    try {
      const { stdout } = await execFile(binary, args, { cwd, maxBuffer, encoding: 'buffer' });
      return stdout;
    } catch (error) {
      const failure = error as ExecFileFailure;
      if (failure.code !== 'ENOENT') {
        throw error;
      }
      this.gitBinary = undefined;
      const { stdout } = await execFile(await this.getGitBinary(), args, { cwd, maxBuffer, encoding: 'buffer' });
      return stdout;
    }
  }

  /** Run git, swallowing failures into an empty string (best-effort probes). */
  private async tryGitOutput(args: string[], cwd: string): Promise<string> {
    return (await this.tryGit(args, cwd)).output;
  }

  /** Run git, reporting whether it succeeded and its stdout. */
  private async tryGit(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
    try {
      return { ok: true, output: await this.git(args, cwd) };
    } catch {
      return { ok: false, output: '' };
    }
  }
}

// ── pure helpers ──

/**
 * Resolve `relPath` inside `workdir`, rejecting absolute paths and any `..`
 * traversal that escapes the workdir. Returns the absolute, normalized path.
 */
function resolveWithinWorkdir(workdir: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('File snapshot path is required');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`File snapshot path must be relative to the session workdir: ${relPath}`);
  }

  const resolvedWorkdir = path.resolve(workdir);
  const resolved = path.resolve(resolvedWorkdir, relPath);
  const relative = path.relative(resolvedWorkdir, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`File snapshot path escapes the session workdir: ${relPath}`);
  }

  return resolved;
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function parseNameStatus(output: string): DiffChange[] {
  const tokens = splitNul(output);
  const changes: DiffChange[] = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) {
      continue;
    }

    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath && newPath) {
        changes.push({ status, oldPath, path: newPath });
      }
      continue;
    }

    const filePath = tokens[index++];
    if (filePath) {
      changes.push({ status, path: filePath });
    }
  }

  return changes;
}

async function readCurrentSnapshot(
  resolvedWorkdir: string,
  filePath: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const realWorkdir = await fs.realpath(resolvedWorkdir);
    const realFile = await fs.realpath(filePath);
    assertPathInside(realWorkdir, realFile, relPath);
    const targetStats = await fs.stat(realFile);
    if (!targetStats.isFile()) {
      throw new Error(`File snapshot is not a regular file: ${relPath}`);
    }
    assertSnapshotSize(targetStats.size, relPath);

    const handle = await fs.open(filePath, 'r');
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) {
        throw new Error(`File snapshot is not a regular file: ${relPath}`);
      }
      if (openedStats.dev !== targetStats.dev || openedStats.ino !== targetStats.ino) {
        throw new Error(`File snapshot target changed during validation: ${relPath}`);
      }
      assertSnapshotSize(openedStats.size, relPath);
      const content = await readBoundedSnapshotBytes(handle, relPath);
      assertTextSnapshot(content, relPath);
      return content.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readBoundedSnapshotBytes(
  reader: BoundedSnapshotReader,
  relPath: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_FILE_SNAPSHOT_BYTES + 1);
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesRead } = await reader.read(buffer, offset, buffer.length - offset, null);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
      throw new Error(`Invalid file snapshot read result: ${relPath}`);
    }
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  assertSnapshotSize(offset, relPath);
  return buffer.subarray(0, offset);
}

function assertPathInside(realWorkdir: string, realFile: string, relPath: string): void {
  const relative = path.relative(realWorkdir, realFile);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`File snapshot path escapes the session workdir: ${relPath}`);
  }
}

function assertSnapshotSize(size: number, relPath: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SNAPSHOT_BYTES) {
    throw new Error(`File snapshot exceeds ${MAX_FILE_SNAPSHOT_BYTES} bytes: ${relPath}`);
  }
}

function assertTextSnapshot(content: Buffer, relPath: string): void {
  if (content.includes(0)) {
    throw new Error(`Binary file snapshots are not supported: ${relPath}`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`Binary file snapshots are not supported: ${relPath}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (code === 'ENOENT' || code === 'ENOTDIR'));
}
