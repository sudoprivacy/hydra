# Repo Registry — Design Notes

This document captures the design of the `hydra repo` registry feature
(currently shipping in two PRs).

## Motivation

Today, spinning up a Hydra worker requires the user to:

1. Manually clone the repo somewhere on disk.
2. Pass that absolute path via `hydra worker create --repo <abs-path>`.

Every developer ends up with their own scattered set of clones. Two pain
points fall out of that:

- **Drift.** A worker's worktree is anchored to whatever local commits the
  user happens to have on `main`. If they forgot to fetch, workers branch
  off stale code.
- **Ergonomics.** Telling an AI agent "create a worker on
  `sudoprivacy/hydra`" requires it to know exactly where the user
  cloned the repo on disk. There's no canonical name.

## Model

```
~/.hydra/
├── repos/
│   └── <owner>/
│       └── <name>/         ← managed clone, mirrors origin/main, never has local commits
└── worktrees/
    └── <repo-identifier>/
        └── <slug>/         ← worker worktree (PR A unchanged; relocation is PR B)
```

**Best practice:** the managed clone in `~/.hydra/repos/<owner>/<name>/`
is treated as a clean cache. Hydra always runs `git fetch origin` before
creating a worker off it, so workers always branch from the freshest
`origin/main` (no surprise local commits, no stale base).

## The `--repo` flag

Three input forms are accepted:

| Input form | Behavior |
| --- | --- |
| `sudoprivacy/hydra` | **Recommended.** Resolves to `~/.hydra/repos/sudoprivacy/hydra/`. Errors with "Run: hydra repo add ..." if not registered. |
| `/Users/me/code/hydra`, `.`, `./foo`, `../foo`, `~/foo` | **Backward-compat.** Used as-is. Existing workflows keep working — `hydra worker create --repo . --branch foo` from a clone is still the natural path-based form. |
| `https://github.com/...` | Rejected with a hint to run `hydra repo add <url>` first. |

Short-form is the canonical default we want users (and agents) to reach
for. Filesystem paths remain supported because lots of people already have
"main" clones they actively develop in.

### Path-vs-identifier dispatch rule

`resolveRepoInput()` decides path-vs-identifier with this rule:

> An input is path-like if it starts with `.`, `/`, `\\`, `~`, or matches a
> Windows drive-letter prefix (`C:\…`, `D:/…`). Otherwise it's a registry
> identifier and goes through `resolveRepoIdentifier`.

Path-like inputs are routed straight through `path.resolve` (with `~`
expansion) and never reach the registry parser. That's what keeps `--repo .`
working while still letting short-form `<owner>/<name>` mean
"managed clone."

### Path-component safety

Owner and name are restricted to `[A-Za-z0-9._-]+` plus a deny-list of
unsafe components: `.`, `..`, `.git`, and any pure-dot string (`.`, `..`,
`...`, …). Without this guard, `parseRepoIdentifier("fake/..")` would
resolve `getRegistryRepoPath("fake", "..")` to `~/.hydra/repos` itself and
`add`/`remove` would operate on the registry root.

## Why a directory layout, not a JSON registry?

State storage is simply the on-disk presence of
`~/.hydra/repos/<owner>/<name>/`. There is no registry JSON file.

- **One source of truth.** The clone either exists or it doesn't. No way
  for a registry file to drift away from the filesystem.
- **Last-fetched timestamp** is derived from
  `<repo>/.git/FETCH_HEAD` mtime — git already maintains it.
- **Simpler concurrency.** No file locking around a metadata file.

If we ever need richer per-repo metadata (e.g. nicknames, default
agent), we'll add a `<repo>/.hydra-meta.json` *inside* the managed clone,
not a top-level registry file.

## PR split: A vs B

This feature ships in two PRs to keep the diffs reviewable.

### PR A — registry CLI + auto-fetch wiring (this PR)

- New `hydra repo {add,list,remove,fetch}` commands.
- `~/.hydra/repos/<owner>/<name>/` directory layout.
- Resolution helper `resolveRepoIdentifier()`.
- `hydra worker create --repo <owner/name>` flow:
  - Resolves to the managed clone.
  - Runs a *required* `git fetch origin` before creating the worktree
    (currently best-effort silent for abs-paths — that stays unchanged).
- `hydra copilot create --repo <owner/name>` runs the copilot inside the
  managed clone with the same auto-fetch.

PR A explicitly **does not** change where worktrees live. They continue
to land at `~/.hydra/worktrees/<repo-identifier>/<slug>/` as today.

### PR B — worktree relocation (deferred)

PR B will move worker worktrees under the managed clone:

```
~/.hydra/
├── repos/<owner>/<name>/
└── worktrees/<owner>/<name>/<slug>/
```

This is deferred because:

- It changes the worktree layout used by `git worktree`, the session
  identity heuristics, and the tree provider.
- It needs a migration story for existing worktrees (re-link them, or
  leave them at the legacy path forever?).
- PR A delivers the user-visible registry without touching that risk.

## Open questions (for review)

These are the non-obvious calls in PR A. I want a steer before PR B.

1. **`repo add` when target exists: no-op or auto-fetch?** PR A goes
   no-op (must explicitly `repo fetch`). Reasoning: `add` is "register
   this repo," not "refresh it." Auto-fetching here surprises the user
   the second time they run the command. Easy to flip if you disagree.

2. **GitHub-only for v1, or accept GitLab/Bitbucket URLs too?** PR A is
   GitHub-only. Auth surface is much smaller (no GitLab tokens, no
   self-hosted GitLab discovery). We can broaden later by adding more
   parsers — the parser is cleanly isolated.

3. **PR B worktree migration:** when a user upgrades and they have
   pre-existing worktrees at the old path — silently keep them, prompt
   for migration, or auto-migrate? My current lean is "keep them; new
   workers go to the new path."

4. **Default base branch behaviour is unchanged** — `getBaseBranchFromRepo`
   still tries `origin/main → main → origin/master → master`. Calling it
   out so we don't accidentally regress.
