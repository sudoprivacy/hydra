import { exec } from '../core/exec';
import { getRepoName, getRepoRootFromPath, localBranchExists, validateBranchName } from '../core/git';
import { shellQuote } from '../core/shell';
import type { ShareRepoInfo } from './types';

function emptyRepoInfo(): ShareRepoInfo {
  return {
    repoName: null,
    repoRoot: null,
    branch: null,
    headCommit: null,
    remotes: {},
  };
}

async function execOrNull(command: string, cwd: string): Promise<string | null> {
  try {
    const output = await exec(command, { cwd });
    return output || null;
  } catch {
    return null;
  }
}

async function collectRemotes(repoRoot: string): Promise<Record<string, string>> {
  const namesOutput = await execOrNull('git remote', repoRoot);
  if (!namesOutput) {
    return {};
  }

  const remotes: Record<string, string> = {};
  for (const name of namesOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    const url = await execOrNull(`git remote get-url ${shellQuote(name)}`, repoRoot);
    if (url) {
      remotes[name] = url;
    }
  }
  return remotes;
}

function repoNameFromRemoteUrl(url: string): string | null {
  const normalized = normalizeRemoteUrl(url);
  const repoName = normalized.split('/').filter(Boolean).pop();
  return repoName || null;
}

function getRepoNameFromRemotes(remotes: Record<string, string>, repoRoot: string): string {
  const originRepoName = remotes.origin ? repoNameFromRemoteUrl(remotes.origin) : null;
  if (originRepoName) {
    return originRepoName;
  }

  for (const remoteUrl of Object.values(remotes)) {
    const repoName = repoNameFromRemoteUrl(remoteUrl);
    if (repoName) {
      return repoName;
    }
  }

  return getRepoName(repoRoot);
}

export async function collectRepoInfo(workdir: string): Promise<ShareRepoInfo> {
  let repoRoot: string;
  try {
    repoRoot = await getRepoRootFromPath(workdir);
  } catch {
    return emptyRepoInfo();
  }

  const [branch, headCommit, remotes] = await Promise.all([
    execOrNull('git branch --show-current', repoRoot),
    execOrNull('git rev-parse HEAD', repoRoot),
    collectRemotes(repoRoot),
  ]);

  return {
    repoName: getRepoNameFromRemotes(remotes, repoRoot),
    repoRoot,
    branch,
    headCommit,
    remotes,
  };
}

function normalizeRemoteUrl(url: string): string {
  let value = url.trim();
  const sshMatch = value.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    value = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    value = value.replace(/^https?:\/\//, '').replace(/^ssh:\/\//, '');
    value = value.replace(/^[^@/]+@/, '');
  }
  value = value.replace(/\.git$/i, '');
  return value.toLowerCase();
}

function hasCommonRemote(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftUrls = new Set(Object.values(left).map(normalizeRemoteUrl).filter(Boolean));
  return Object.values(right).some(url => leftUrls.has(normalizeRemoteUrl(url)));
}

async function commitExists(repoRoot: string, commit: string): Promise<boolean> {
  try {
    await exec(`git cat-file -e ${shellQuote(`${commit}^{commit}`)}`, { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

export async function validateRepoMatch(
  bundleRepo: ShareRepoInfo,
  targetRepoRoot: string,
  allowMismatch = false,
): Promise<ShareRepoInfo> {
  const targetRepo = await collectRepoInfo(targetRepoRoot);
  if (allowMismatch) {
    return targetRepo;
  }

  if (!targetRepo.repoRoot) {
    throw new Error(`Target repo path is not a git repository: ${targetRepoRoot}`);
  }

  const bundleRemoteCount = Object.keys(bundleRepo.remotes || {}).length;
  const targetRemoteCount = Object.keys(targetRepo.remotes || {}).length;
  const canCompareRemotes = bundleRemoteCount > 0 && targetRemoteCount > 0;
  const hasSharedRemote = canCompareRemotes && hasCommonRemote(bundleRepo.remotes, targetRepo.remotes);
  if (canCompareRemotes && !hasSharedRemote) {
    throw new Error('Repo remote mismatch. Use --allow-mismatch to override.');
  }

  if (!hasSharedRemote && bundleRepo.repoName && targetRepo.repoName && bundleRepo.repoName !== targetRepo.repoName) {
    throw new Error(
      `Repo name mismatch: share is for "${bundleRepo.repoName}", target is "${targetRepo.repoName}". Use --allow-mismatch to override.`,
    );
  }

  if (bundleRepo.headCommit && !(await commitExists(targetRepo.repoRoot, bundleRepo.headCommit))) {
    throw new Error(
      `Target repo does not contain shared HEAD commit ${bundleRepo.headCommit}. Use --allow-mismatch to override.`,
    );
  }

  return targetRepo;
}

export async function ensureLocalBranchFromRemote(repoRoot: string, branchName: string): Promise<void> {
  const validationError = validateBranchName(branchName);
  if (validationError) {
    throw new Error(validationError);
  }

  if (await localBranchExists(repoRoot, branchName)) {
    return;
  }

  const remoteRef = `origin/${branchName}`;
  try {
    await exec(`git rev-parse --verify ${shellQuote(remoteRef)}`, { cwd: repoRoot });
  } catch {
    throw new Error(`Shared worker branch "${branchName}" does not exist locally or at origin.`);
  }

  await exec(`git branch ${shellQuote(branchName)} ${shellQuote(remoteRef)}`, { cwd: repoRoot });
}
