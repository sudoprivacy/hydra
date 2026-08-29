// Git change counts + PR overlay for the sidebar `U:N` token and worker context
// (app-internal seam verb).
//
// Mirrors the old VS Code tree's probes (packages/extension
// tmuxSessionProvider.ts): run `git status --porcelain` in a worker's worktree
// and count the changed files (modified + added + untracked), and run
// `gh pr list` once per repo — matched to each worker by branch — for the PR
// number/state/url. Only CODE workers are probed — task workers (plain folders)
// and copilots get neither, exactly like the old tree. The engine logic lives
// here (never in @hydra/protocol, which stays engine-free); the handler in
// appService.ts maps each code worker to its status.

import * as fs from 'node:fs';

import { exec } from '@hydra/core/exec';
import { isDirectoryWorker, type WorkerInfo } from '@hydra/core/sessionManager';
import type { GitChangeStatus, GitStatusMap } from '@hydra/protocol';

interface PrInfo {
  number: number;
  state: 'open' | 'closed' | 'merged';
  url: string;
}

// Cache PR lookups per repo so an interval-polled board never hammers `gh`, and
// never blocks the git-status batch on gh CLI latency — mirrors the extension's
// fetchRepoPrStatuses (tmuxSessionProvider.ts ~315).
const PR_STATUS_CACHE_TTL_MS = 30_000;
const PR_STATUS_FETCH_TIMEOUT_MS = 3_000;
const prStatusCache = new Map<string, { fetchedAt: number; value: Map<string, PrInfo> }>();

/**
 * Map of `headRefName` → PR for a repo, via `gh pr list`. Best-effort: a
 * timeout, a missing/unauthenticated `gh`, or a non-zero exit all fall back to
 * the last good cache (or an empty map), and never throw.
 */
async function fetchRepoPrStatuses(repoRoot: string): Promise<Map<string, PrInfo>> {
  const cached = prStatusCache.get(repoRoot);
  if (cached && Date.now() - cached.fetchedAt < PR_STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const map = new Map<string, PrInfo>();
  try {
    const json = await Promise.race([
      exec(
        'gh pr list --state all --json headRefName,number,state,url --limit 100',
        { cwd: repoRoot, logFailure: false },
      ),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('gh pr list timeout')), PR_STATUS_FETCH_TIMEOUT_MS),
      ),
    ]);
    const prs: { headRefName: string; number: number; state: string; url: string }[] = JSON.parse(json);
    // Keep the first (most recent) PR per branch.
    for (const pr of prs) {
      if (!map.has(pr.headRefName)) {
        const state = pr.state === 'MERGED' ? 'merged'
          : pr.state === 'CLOSED' ? 'closed'
            : 'open';
        map.set(pr.headRefName, { number: pr.number, state, url: pr.url });
      }
    }
  } catch {
    if (cached) return cached.value;
  }

  prStatusCache.set(repoRoot, { fetchedAt: Date.now(), value: map });
  return map;
}

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

  // Prefetch PR statuses once per repo (cached, best-effort), then match each
  // worker by its branch. Runs concurrently with — and independently of — the
  // per-worktree change-count probes below.
  const repoRoots = [...new Set(codeWorkers.map((worker) => worker.repoRoot).filter((root): root is string => Boolean(root)))];
  const prByRepo = new Map<string, Map<string, PrInfo>>();
  await Promise.all(repoRoots.map(async (repoRoot) => {
    prByRepo.set(repoRoot, await fetchRepoPrStatuses(repoRoot));
  }));

  const entries = await Promise.all(
    codeWorkers.map(async (worker) => {
      const session = worker.sessionName || worker.tmuxSession;
      const changed = await countChangedFiles(worker.workdir);
      const status: GitChangeStatus = { changed };
      const pr = worker.repoRoot && worker.branch
        ? prByRepo.get(worker.repoRoot)?.get(worker.branch)
        : undefined;
      if (pr) {
        status.prNumber = pr.number;
        status.prState = pr.state;
        status.prUrl = pr.url;
      }
      return [session, status] as const;
    }),
  );

  const statuses: GitStatusMap = {};
  for (const [session, status] of entries) {
    statuses[session] = status;
  }
  return statuses;
}
