import * as path from 'path';
import { execFile as execFileCallback } from 'child_process';
import * as fs from 'fs/promises';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { resolveCommandPath } from '@hydra/core/exec';
import { HYDRA_PREFIX_REVIEW, findReviewGroupColumn, focusEditorGroup } from '../utils/hydraEditorGroup';

const execFile = promisify(execFileCallback);
const REVIEW_SCHEME = 'hydra-git';
const MAX_GIT_OUTPUT = 50 * 1024 * 1024;
const REVIEW_LABEL_PREFIX = `${HYDRA_PREFIX_REVIEW} `;

interface ExecFileFailure extends Error {
  code?: string | number;
}

interface ReviewLayoutState {
  column: vscode.ViewColumn;
  maximized: boolean;
}

let reviewLayout: ReviewLayoutState | undefined;
let layoutListenersRegistered = false;

interface ReviewChange {
  status: string;
  path: string;
  oldPath?: string;
}

interface SnapshotQuery {
  worktreePath: string;
  ref?: string;
  filePath?: string;
  empty?: boolean;
  current?: boolean;
}

let gitBinary: string | undefined;
let providerDisposable: vscode.Disposable | undefined;

async function getGitBinary(): Promise<string> {
  if (gitBinary) {
    return gitBinary;
  }

  const resolved = await resolveCommandPath('git');
  if (!resolved) {
    throw new Error('git not found');
  }
  gitBinary = resolved;
  return gitBinary;
}

async function git(args: string[], cwd: string): Promise<string> {
  const binary = await getGitBinary();
  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFile(binary, args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT,
    }));
  } catch (error) {
    const failure = error as ExecFileFailure;
    if (failure.code !== 'ENOENT') {
      throw error;
    }

    gitBinary = undefined;
    ({ stdout } = await execFile(await getGitBinary(), args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT,
    }));
  }
  return stdout.toString();
}

async function tryGit(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

function ensureReviewContentProvider(): void {
  if (providerDisposable) {
    return;
  }

  providerDisposable = vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
    async provideTextDocumentContent(uri): Promise<string> {
      const query = parseSnapshotQuery(uri);
      if (!query || !query.filePath || query.empty) {
        return '';
      }

      if (query.current) {
        return tryReadFile(path.join(query.worktreePath, query.filePath));
      }

      if (!query.ref) {
        return '';
      }
      return tryGit(['show', `${query.ref}:${query.filePath}`], query.worktreePath);
    },
  });
}

function parseSnapshotQuery(uri: vscode.Uri): SnapshotQuery | undefined {
  try {
    const parsed = JSON.parse(uri.query) as Partial<SnapshotQuery>;
    if (typeof parsed.worktreePath !== 'string' || !parsed.worktreePath) {
      return undefined;
    }
    return {
      worktreePath: parsed.worktreePath,
      ref: typeof parsed.ref === 'string' ? parsed.ref : undefined,
      filePath: typeof parsed.filePath === 'string' ? parsed.filePath : undefined,
      empty: parsed.empty === true,
      current: parsed.current === true,
    };
  } catch {
    return undefined;
  }
}

async function tryReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function reviewUri(worktreePath: string, filePath: string, query: Omit<SnapshotQuery, 'worktreePath' | 'filePath'>): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    path: `/${filePath}`,
    query: JSON.stringify({ worktreePath, filePath, ...query }),
  });
}

function snapshotUri(worktreePath: string, ref: string, filePath: string): vscode.Uri {
  return reviewUri(worktreePath, filePath, { ref });
}

function emptyUri(worktreePath: string, filePath: string): vscode.Uri {
  return reviewUri(worktreePath, filePath, { empty: true });
}

function currentUri(worktreePath: string, filePath: string): vscode.Uri {
  return reviewUri(worktreePath, filePath, { current: true });
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function parseNameStatus(output: string): ReviewChange[] {
  const tokens = splitNul(output);
  const changes: ReviewChange[] = [];

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

async function getCurrentBranch(worktreePath: string): Promise<string> {
  return (await tryGit(['branch', '--show-current'], worktreePath)).trim();
}

async function getReviewBaseRef(worktreePath: string): Promise<string> {
  const isWorktree = (await git(['rev-parse', '--is-inside-work-tree'], worktreePath)).trim();
  if (isWorktree !== 'true') {
    throw new Error(`Not a git worktree: ${worktreePath}`);
  }

  const branch = await getCurrentBranch(worktreePath);
  if (branch) {
    const configuredBase = (await tryGit(['config', '--get', `branch.${branch}.vscode-merge-base`], worktreePath)).trim();
    if (configuredBase && await refExists(worktreePath, configuredBase)) {
      return configuredBase;
    }
  }

  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  for (const candidate of candidates) {
    if (await refExists(worktreePath, candidate)) {
      return candidate;
    }
  }

  const suffix = branch ? ` on branch "${branch}"` : '';
  throw new Error(`Unable to find a base branch for this worktree${suffix}: ${worktreePath}`);
}

async function refExists(worktreePath: string, ref: string): Promise<boolean> {
  return Boolean((await tryGit(['rev-parse', '--verify', `${ref}^{commit}`], worktreePath)).trim());
}

async function getMergeBase(worktreePath: string, baseRef: string): Promise<string> {
  const mergeBase = (await tryGit(['merge-base', baseRef, 'HEAD'], worktreePath)).trim();
  return mergeBase || baseRef;
}

async function getReviewChanges(worktreePath: string, baseCommit: string): Promise<ReviewChange[]> {
  const trackedChanges = parseNameStatus(
    await tryGit(['diff', '--name-status', '--find-renames', '-z', baseCommit, '--'], worktreePath)
  );
  const seen = new Set(trackedChanges.map(change => change.path));

  const untracked = splitNul(await tryGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath));
  for (const filePath of untracked) {
    if (!seen.has(filePath)) {
      trackedChanges.push({ status: 'A', path: filePath });
      seen.add(filePath);
    }
  }

  return trackedChanges.sort((a, b) => a.path.localeCompare(b.path));
}

function getResourceUri(worktreePath: string, change: ReviewChange): vscode.Uri {
  return currentUri(worktreePath, change.path);
}

function getOriginalUri(worktreePath: string, baseCommit: string, change: ReviewChange): vscode.Uri {
  if (change.status.startsWith('A')) {
    return emptyUri(worktreePath, change.path);
  }
  return snapshotUri(worktreePath, baseCommit, change.oldPath || change.path);
}

function getModifiedUri(worktreePath: string, change: ReviewChange): vscode.Uri {
  if (change.status.startsWith('D')) {
    return emptyUri(worktreePath, change.path);
  }
  return currentUri(worktreePath, change.path);
}

function getDiffTitle(worktreePath: string, baseRef: string, changes: ReviewChange[]): string {
  const name = path.basename(worktreePath);
  return `${REVIEW_LABEL_PREFIX}${name}: ${changes.length} change${changes.length === 1 ? '' : 's'} since ${baseRef}`;
}

function getFallbackDiffTitle(filePath: string, baseRef: string): string {
  return `${REVIEW_LABEL_PREFIX}${filePath} (${baseRef} ↔ worker)`;
}

async function openFallbackDiff(
  worktreePath: string,
  baseCommit: string,
  baseRef: string,
  changes: ReviewChange[],
  targetColumn: vscode.ViewColumn,
): Promise<void> {
  const first = changes[0];
  await vscode.commands.executeCommand(
    'vscode.diff',
    getOriginalUri(worktreePath, baseCommit, first),
    getModifiedUri(worktreePath, first),
    getFallbackDiffTitle(first.path, baseRef),
    { preview: false, viewColumn: targetColumn }
  );

  if (changes.length > 1) {
    vscode.window.showInformationMessage(
      `Opened the first of ${changes.length} worker changes. Update VS Code to use the full changes editor.`
    );
  }
}

async function ensureReviewGroupFocused(): Promise<{ column: vscode.ViewColumn; created: boolean }> {
  const existing = findReviewGroupColumn();
  if (existing !== undefined) {
    await focusEditorGroup(existing);
    return { column: existing, created: false };
  }

  // Create a new group to the right of the active one. VS Code focuses the new group.
  await vscode.commands.executeCommand('workbench.action.newGroupRight');
  const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  return { column, created: true };
}

async function maximizeReviewGroup(column: vscode.ViewColumn): Promise<boolean> {
  // Only toggle when not already maximized by us — toggle is symmetric and would flip wrong direction.
  if (reviewLayout?.maximized && reviewLayout.column === column) {
    return true;
  }
  try {
    await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
    return true;
  } catch {
    return false;
  }
}

function ensureReviewLayoutListeners(): void {
  if (layoutListenersRegistered) {
    return;
  }
  layoutListenersRegistered = true;

  vscode.window.tabGroups.onDidChangeTabs(() => { void onReviewLayoutMaybeChanged(); });
  vscode.window.tabGroups.onDidChangeTabGroups(() => { void onReviewLayoutMaybeChanged(); });
}

async function onReviewLayoutMaybeChanged(): Promise<void> {
  const state = reviewLayout;
  if (!state) {
    return;
  }

  const group = vscode.window.tabGroups.all.find(g => g.viewColumn === state.column);

  // Group disappeared (VS Code auto-closed the empty group, or user closed it manually).
  // VS Code clears its own maximize state when the maximized group is removed.
  if (!group) {
    reviewLayout = undefined;
    return;
  }

  // Last review tab closed but group lingers (e.g. workbench.editor.closeEmptyGroups disabled,
  // or user dragged a non-review tab in earlier).
  if (group.tabs.length === 0) {
    if (state.maximized) {
      try {
        await focusEditorGroup(state.column);
        await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
      } catch {
        // best-effort
      }
    }
    try {
      await vscode.window.tabGroups.close(group);
    } catch {
      // best-effort
    }
    reviewLayout = undefined;
    return;
  }

  // Group still has tabs. If the active group moved away while we believed we were maximized,
  // the user must have manually unmaximized — sync our flag so we don't re-toggle the wrong way.
  if (state.maximized) {
    const active = vscode.window.tabGroups.activeTabGroup;
    if (active.viewColumn !== state.column) {
      state.maximized = false;
    }
  }
}

export async function openChangesReview(worktreePath: string): Promise<void> {
  ensureReviewContentProvider();
  ensureReviewLayoutListeners();

  const baseRef = await getReviewBaseRef(worktreePath);
  const baseCommit = await getMergeBase(worktreePath, baseRef);
  const changes = await getReviewChanges(worktreePath, baseCommit);

  if (changes.length === 0) {
    vscode.window.showInformationMessage('No worker changes to review.');
    return;
  }

  const resources = changes.map(change => [
    getResourceUri(worktreePath, change),
    getOriginalUri(worktreePath, baseCommit, change),
    getModifiedUri(worktreePath, change),
  ]);

  const { column: targetColumn, created } = await ensureReviewGroupFocused();

  try {
    await vscode.commands.executeCommand('vscode.changes', getDiffTitle(worktreePath, baseRef, changes), resources);
  } catch {
    await openFallbackDiff(worktreePath, baseCommit, baseRef, changes, targetColumn);
  }

  if (created) {
    const ok = await maximizeReviewGroup(targetColumn);
    reviewLayout = { column: targetColumn, maximized: ok };
  } else if (!reviewLayout) {
    // Group existed before this session — leave maximize state alone, assume not maximized by us.
    reviewLayout = { column: targetColumn, maximized: false };
  } else {
    reviewLayout.column = targetColumn;
  }
}
