// Git change counts for the sidebar `U:N` token (app-internal seam verb).
//
// Mirrors the old VS Code tree's git-status probe (packages/extension
// tmuxSessionProvider.ts ~lines 152/952): run `git status --porcelain` in a
// worker's worktree and count the changed files (modified + added + untracked).
// Only CODE workers are probed — task workers (plain folders) and copilots get
// no `U:N`, exactly like the old tree. The counting logic lives here (never in
// @hydra/protocol, which stays engine-free); the handler in appService.ts maps
// each code worker to its count.

import * as fs from 'node:fs';

import { exec } from '@hydra/core/exec';
import { isDirectoryWorker, type WorkerInfo } from '@hydra/core/sessionManager';
import type { GitStatusMap } from '@hydra/protocol';

/**
 * Count changed files in a worktree — the number of non-empty
 * `git status --porcelain` lines (modified + added + untracked), matching the
 * old tree's `gitDirty`. Best-effort: a clean tree, a missing path, or a
 * non-git directory all report 0, and a failing git probe never throws.
 */
export async function countChangedFiles(workdir: string): Promise<number> {
  if (!workdir || !fs.existsSync(workdir)) {
    return 0;
  }
  try {
    const output = await exec('git status --porcelain', { cwd: workdir, logFailure: false });
    return output
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .length;
  } catch {
    return 0;
  }
}

/**
 * Changed-file counts for every code worker with a worktree, batched. Task
 * workers and copilots are skipped so the renderer never shows `U:N` for them.
 * The git probes run concurrently to keep the whole batch cheap.
 */
export async function collectCodeWorkerGitStatus(
  workers: readonly WorkerInfo[],
): Promise<GitStatusMap> {
  const codeWorkers = workers.filter((worker) => !isDirectoryWorker(worker) && Boolean(worker.workdir));
  const entries = await Promise.all(
    codeWorkers.map(async (worker) => {
      const session = worker.sessionName || worker.tmuxSession;
      const changed = await countChangedFiles(worker.workdir);
      return [session, { changed }] as const;
    }),
  );

  const statuses: GitStatusMap = {};
  for (const [session, status] of entries) {
    statuses[session] = status;
  }
  return statuses;
}
