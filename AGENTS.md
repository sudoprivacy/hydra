# Hydra — Agent Operating Manual

Hydra is a VS Code extension that lets an AI agent orchestrate parallel workers. A worker is a tmux session + AI agent running in a workdir; code workers add a git worktree and branch, while task workers use a plain folder. You manage them through the `hydra` CLI.

Guidelines for AI agents and developers working on this project.

## Build & Test

```bash
npm install           # Install dependencies
npm run compile       # Build extension
npm run lint          # Run ESLint
```

After changes, always run `npm run compile` to verify the build succeeds before committing.

### Manual Testing

To test the extension in a VS Code Extension Development Host, use the `/test-hydra` skill. See [`skills/test-hydra/SKILL.md`](./skills/test-hydra/SKILL.md).

## Project Structure

```
.
├── src/                    # VS Code Extension (TypeScript)
│   ├── extension.ts        # Entry point
│   ├── commands/           # Command implementations
│   ├── providers/          # Tree data providers (sidebar)
│   ├── core/               # Agent config, worker lifecycle
│   ├── resources/          # Agent instruction templates
│   └── utils/              # tmux, git, session utilities
├── out/                    # Compiled output
├── skills/                 # Skill definitions (SSOT, surfaced via .claude/skills, .codex/skills, and .gemini/skills)
└── resources/              # Icons and assets
```

## Key Patterns

- **Worker Sources**: Code workers are repo/branch/git-worktree backed. Task workers are directory-backed and have no repo, branch, or git worktree.
- **Worktree Location**: Extension-managed code-worker worktrees go under `~/.hydra/worktrees/<repo-identifier>/` (outside the repo to avoid tool/config leakage from parent). Legacy worktrees under `<repo>/.hydra/worktrees/` and `~/.tmux-worktrees/<hash>/` are still recognized.
- **Task Folder Location**: Hydra-managed task-worker folders go under `~/.hydra/tasks/<task-slug>/`. User-provided task folders are never deleted unless a product decision introduces a separate force flag.
- **Session Namespace**: Code workers use `{repoName}-{pathHash}_{branchSlug}` for collision safety across same-name repos in different directories. Task workers use `task_<taskSlug>`.
- **Root Detection**: Compare worktree path to primary via `git rev-parse --git-common-dir` — never infer from branch name or folder basename.
- **Slug Collision**: basename → parent dir disambiguation → short path hash. Reserve `main` for the primary worktree.
- **Canonical Path Matching**: Normalize to absolute paths with `~` expansion for equality checks. Do not collapse symlinks via `realpath`.
- **Unpublished Task Branches**: Don't set `branch.<name>.remote`/`.merge` before first push — VS Code SCM would try to sync against a non-existent remote. Set only `branch.<name>.vscode-merge-base`.
- **Tree Context Menu**: Use per-type `contextValue` — `copilotItem`, `workerItem`, `inactiveWorkerItem`, `taskWorkerItem`, `inactiveTaskWorkerItem`, `detailItem`, `gitStatusItem` — to scope right-click actions to relevant item types.
- **No-Git Workspace**: Show one primary item labeled `current project (no git)` mapped to workspace path.
- **Polymorphism**: Commands must handle `TmuxItem` base class and variants (`TmuxSessionItem`, `InactiveWorktreeItem`, etc.). Use `getWorktreePath(item)` helper.
- **Legacy Compatibility**: Centralized in `src/utils/sessionCompatibility.ts`.
- **Language**: English for all comments, docs, and UI strings.

## Terminal & tmux Integration

Critical lessons learned — do not change without understanding the full implications:

- **Terminal Creation**: Use `/bin/sh -c 'exec tmux attach ...'` — NOT `shellPath: 'tmux'` (breaks mouse drag/pane resize) or `terminal.sendText` (race condition with other extensions).
- **Shell Integration**: Set `TERM_PROGRAM`, `VSCODE_SHELL_INTEGRATION`, `VSCODE_INJECTION` to `null` to prevent OSC 633 interference inside tmux.
- **Environment Pollution**: Scrub `VSCODE_*` and `ELECTRON_RUN_AS_NODE` from tmux server environment before `new-session` and before `attach` — long-lived tmux servers re-poison new panes otherwise.
- **Clipboard**: Set `set-clipboard on`, `terminal-features ...:clipboard`, `terminal-overrides ...:clipboard` before attach for OSC52 in Remote-SSH. Enable `allow-passthrough on` for agent TUI clipboard support.
- **Startup Size Race**: Delay initial attach briefly, sync `default-size` from `stty size`, then `resize-window` to avoid 80x24 first-paint. Restore `window-size latest` after forced resize.
- **Shell Script Assembly**: Join `/bin/sh -c` fragments with newlines, not `; `, to avoid `do;` syntax errors.

## UI/UX

- **Session Presentation**: Two-line layout (Group/Status + Detail).
- **Terminal Interaction**: Open in Editor Area (Tabs) by default.
- **Tree Levels**: Code worker Level 2 = branch/HEAD with green circle status, Level 3 = tmux usage, Level 4 = git summary (only when non-empty). Task workers are grouped under `Local Tasks` and show folder/workdir language, not worktree language.
- **Current Workspace**: Sort to top with `👆` marker, match against workspace folder path.
- **Deduplication**: Active Session > Inactive Worktree.

## Coding Standards

- TypeScript: `async/await` for all I/O, `try-catch` for error handling
- Match existing code style and conventions
- Run `npm run compile` and `npm run lint` before committing
- Descriptive, conventional commit messages

## Release Workflow

See [`skills/release-hydra/SKILL.md`](./skills/release-hydra/SKILL.md) for the full release SOP.

---

## Install

**Prerequisites:** Node.js 18+, git, tmux (macOS/Linux only).

**Option A — VS Code extension (recommended):**
1. Install the **Hydra Code** extension from the VS Code Marketplace
2. The CLI is auto-installed at `~/.hydra/bin/hydra` on first activation
3. PATH is automatically added to your shell profile (`~/.zshrc` or `~/.bashrc`)
4. Restart your shell or open a new terminal, then verify: `hydra --version`

**Option B — Manual setup:** Run `Hydra: Setup CLI` from the VS Code command palette.

The CLI is a thin wrapper that delegates to the extension's bundled Node.js code — it always stays in sync with the extension version. When VS Code updates the extension, the CLI picks up the new code automatically.

## Quick start

```bash
hydra list --json                                    # What's running?
hydra config set default-agent codex                 # Optional: make Codex the default agent
hydra copilot create --workdir .                     # Launch a copilot in the current directory
hydra worker create --repo . --branch feat/foo       # Spawn a worker
hydra worker create --dir ~/notes --name research    # Spawn a task worker
hydra worker logs <session> --lines 30               # Read its output
hydra worker send <session> "fix the failing test"   # Send instructions
hydra copilot restore <session>                      # Restore an archived copilot by session name
hydra worker delete <session>                        # Clean up
```

All commands support `--json` (auto-enabled when piped), `--quiet`, and `--no-interactive`.

## CLI overview

- `hydra list` shows active copilots and workers.
- `hydra worker ...` creates, inspects, messages, restarts, and deletes worker sessions.
- `hydra copilot ...` creates, inspects, messages, renames, restores, and deletes copilot sessions.
- `hydra archive ...` inspects archived sessions and restores them by name.
- `hydra config ...` shows and updates CLI defaults such as `default-agent`.

## CLI discovery

Use the CLI itself as the source of truth:

```bash
hydra --help
hydra worker --help
hydra copilot --help
hydra archive --help
```

Prefer `--json` when scripting or when another agent will parse the output.

## Copilot workflow

When orchestrating multiple workers, follow this loop:

1. **Plan** — Break the task into independent units of work
2. **Delegate** — `hydra worker create` one worker per unit
3. **Monitor** — `hydra worker logs <session>` to check progress
4. **Review** — `git -C <workdir> diff --stat` to inspect changes
5. **Iterate** — `hydra worker send <session> "<correction>"` if needed
6. **Ship** — Push branches and create PRs for approved work

### Reviewing worker output

```bash
# Check what the worker is doing
hydra worker logs <session> --lines 30

# Inspect the code changes
git -C <workdir> diff --stat
git -C <workdir> diff
git -C <workdir> log --oneline main..HEAD
```

The `workdir` is returned in every create/start/list response.

### Creating PRs from worker branches

```bash
git -C <workdir> push -u origin <branch>
gh pr create -R <owner>/<repo> --head <branch> --title "<title>" --body "<body>"
```

### Cleaning up

1. `hydra list --json` to get all workers
2. Cross-reference with `gh pr list --state all --json headRefName,state` to find merged/closed branches
3. `hydra worker delete <session>` for each (one at a time, not in a loop)

## Rules

- **One branch per code worker** — don't reuse sessions for unrelated tasks
- **Copilot owns worker creation** — workers must not run `hydra worker create`; if more parallel work is needed, ask the parent copilot to create and assign another worker
- **Be specific in tasks** — include file paths, function names, and acceptance criteria
- **Parallelize independent work** — two non-conflicting tasks = two workers
- **Review before shipping** — always read the full diff before creating a PR
- **Delete one at a time** — bulk deletion can hang the VS Code sidebar
- **Use `--json` for programmatic access** — parse structured output, don't scrape text
