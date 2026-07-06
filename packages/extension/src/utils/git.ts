import * as vscode from 'vscode';
import * as path from 'path';
import * as coreGit from '../core/git';
import { exec } from '../core/exec';
import { toCanonicalPath } from '../core/path';
import { getActiveBackend } from './multiplexer';

// Re-export pure functions directly
export { isGitRepo, findGitReposInDir, validateBranchName, localBranchExists } from '../core/git';
export { getRepoName, getManagedWorktreesRoot, getManagedRepoWorktreesDir, getRepoIdentifier } from '../core/git';
export { getInRepoWorktreesDir, resolveRepoRootFromWorktreePath } from '../core/git';
export { ensureWorktreesDir, listWorktrees, getWorktreeBranch } from '../core/git';
export { addWorktree, removeWorktree } from '../core/git';
export type { Worktree } from '../core/types';

// Wrappers that inject the active backend
export function branchNameToSlug(branchName: string): string {
  return coreGit.branchNameToSlug(branchName, getActiveBackend());
}

export function getRepoSessionNamespace(repoRoot: string): string {
  return coreGit.getRepoSessionNamespace(repoRoot, getActiveBackend());
}

export function isSlugTaken(slug: string, repoSessionNamespace: string, repoRoot: string): Promise<boolean> {
  return coreGit.isSlugTaken(slug, repoSessionNamespace, repoRoot, getActiveBackend());
}

export function getLegacyManagedRepoWorktreesDir(repoRoot: string): string {
  return coreGit.getLegacyManagedRepoWorktreesDir(repoRoot, getActiveBackend());
}

export function getLegacyTmuxWorktreesDir(repoRoot: string): string {
  return coreGit.getLegacyTmuxWorktreesDir(repoRoot, getActiveBackend());
}

export function isManagedWorktreePath(repoRoot: string, worktreePath: string): boolean {
  return coreGit.isManagedWorktreePath(repoRoot, worktreePath, getActiveBackend());
}

// vscode-specific functions (kept here)
export function getRepoRoot(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error('No workspace folder open.');
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && workspaceFolders.length > 1) {
    const activeUri = activeEditor.document.uri;
    const activePath = toCanonicalPath(activeUri.fsPath) || path.resolve(activeUri.fsPath);
    const matchingFolder = workspaceFolders.find(f => {
      const folderPath = toCanonicalPath(f.uri.fsPath) || path.resolve(f.uri.fsPath);
      return activePath === folderPath || activePath.startsWith(`${folderPath}${path.sep}`);
    });
    if (matchingFolder) {
      return matchingFolder.uri.fsPath;
    }
  }

  return workspaceFolders[0].uri.fsPath;
}

export async function getBaseBranch(repoRoot: string): Promise<string> {
  const override = vscode.workspace.getConfiguration('hydra').get<string>('baseBranch')
    || vscode.workspace.getConfiguration('tmuxWorktree').get<string>('baseBranch');
  if (override) {
    try {
      await exec(`git rev-parse --verify ${override}`, { cwd: repoRoot });
      return override;
    } catch {
      throw new Error(`Configured baseBranch "${override}" not found in repository`);
    }
  }

  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  for (const candidate of candidates) {
    try {
      await exec(`git rev-parse --verify ${candidate}`, { cwd: repoRoot });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error('No default branch found (tried: origin/main, main, origin/master, master)');
}
