---
name: hydra
description: Use when you need to create a Hydra worker from natural language by resolving a repo, branch, and agent, then launching the corresponding worker session.
---

# Skill: hydra

Create and manage Hydra workers (git worktree + tmux session + AI agent) from natural language.

## Prerequisites

Requires: **Node.js 18+**, **git**, **tmux** (macOS/Linux only — tmux is not available on Windows).

The CLI is automatically installed when the Hydra VS Code extension activates:

1. Install the **Hydra Code** VS Code extension
2. The CLI is automatically installed at `~/.hydra/bin/hydra`
3. Add to your shell profile: `export PATH="$HOME/.hydra/bin:$PATH"`
4. Verify: `hydra --version`

## Invocation

The user says something like:
- "create a worker for feat/auth on sudocode"
- "spin up a worker on hydra for fix/bug-123 with codex"
- "clean up completed workers"

## Instructions

### Creating workers

Only copilots create workers. If you are running inside a Hydra worker workdir and need more parallel help, ask the parent copilot to create and assign another worker instead of running `hydra worker create` yourself.

1. **Parse the user's request** to extract:
   - **repo**: A path or short name (e.g., "sudocode", "hydra", "~/code/foo")
   - **branch**: The git branch to create (e.g., "feat/auth", "fix/bug-123")
   - **agent** (optional): Agent type — uses `hydra config get default-agent` when omitted
   - **task** (optional): A task description or prompt for the agent

2. **Resolve repo name to path** if not an absolute path:
   - Search in `~/code/<name>` first, then `~/code/*/<name>` (e.g. `~/code/org/myproject`)
   - Then try the current working directory if it matches
   - If ambiguous, ask the user

3. **Run the command**:
   ```bash
   hydra worker create --repo <resolved_path> --branch <branch> --agent <agent> [--task "<task>"] [--task-file <path>]
   ```

   Available options:
   - `--repo <path>` — Path to the repository (required)
   - `--branch <name>` — Branch name to create (required)
   - `--agent <type>` — Agent type override: `claude`, `codex`, `gemini`, `sudocode`, `custom`
   - `--base <branch>` — Base branch override (defaults to main/master)
   - `--task <prompt>` — Task prompt for the agent
   - `--task-file <path>` — Path to a markdown file with detailed requirements (recommended for complex tasks)

### Monitoring workers

```bash
# List running workers
hydra list --json

# Read last 20 lines of a worker's terminal
hydra worker logs <session> --lines 20

# Read deeper scrollback
hydra worker logs <session> --lines 200
```

### Reviewing changes

Worker worktrees live at `<repo>/.hydra/worktrees/<slug>/`.

```bash
git -C <worktree_path> diff --stat
git -C <worktree_path> diff
git -C <worktree_path> log --oneline <base_branch>..HEAD
```

### Sending follow-up instructions

```bash
# Send to a single worker
hydra worker send <session> "<message>"

# Broadcast to all running workers
hydra worker send --all "<message>"
```

### Creating PRs from worker branches

```bash
cd <worktree_path>
git push -u origin <branch_name>
gh pr create --title "<title>" --body "<description>"
```

### Cleaning up workers

When the user asks to clean up, delete, or remove workers:

1. **List workers**: Run `hydra list` to see all workers and their branches.
2. **Cross-reference with PRs**: Use `gh pr list -R <repo> --state all --json headRefName,state` to identify which worker branches are merged/closed.
3. **Ask the user** which workers to delete before proceeding.
4. **Delete one at a time** to avoid UI issues:
   ```bash
   hydra worker delete <session-name>
   ```
   Do NOT bulk-delete in a loop — the Hydra sidebar can hang when many workers are removed at once.

### Other commands

- `hydra list` — List all copilots and workers
- `hydra worker logs <session> [--lines N]` — Read worker terminal output (default: 50 lines)
- `hydra worker send <session> <message>` — Send a message to a worker (reliable double-Enter)
- `hydra worker send --all <message>` — Broadcast to all running workers
- `hydra worker stop <session>` — Stop a worker (kill tmux session, keep worktree)
- `hydra worker start <session>` — Start a stopped worker
- `hydra worker delete <session>` — Delete a worker (kill session + remove worktree + delete branch)

## Copilot role

When acting as a **copilot** (orchestrating multiple workers), follow this workflow:

1. **Plan** — Break the task into parallelizable units of work
2. **Delegate** — Spawn a worker per unit via `hydra worker create`
3. **Monitor** — Poll worker terminals via `hydra worker logs <session>`
4. **Review** — Read diffs in worker worktrees, check quality
5. **Iterate** — Send corrections via `hydra worker send <session> "<message>"`
6. **Ship** — Push and create PRs for approved branches

**Rules:**
- Never implement code directly — always delegate to workers
- Workers must not create other workers directly; they should ask the parent copilot when more parallel work is needed
- Be specific in task prompts — include file paths, function names, and acceptance criteria
- Parallelize independent work — two non-conflicting tasks = two workers
- Review before shipping — always read the full diff before creating a PR
- One branch per worker — don't reuse sessions for unrelated tasks

## Examples

User: "create a worker for feat/auth on sudocode"
→ `hydra worker create --repo ~/code/org/sudocode --branch feat/auth`

User: "new worker with task 'refactor the API layer'"
→ `hydra worker create --repo $(pwd) --branch task/refactor-api --task "refactor the API layer"`

User: "clean up old workers"
→ Run `hydra list`, cross-reference with merged PRs, ask user, then delete confirmed ones one at a time.

User: "list all workers"
→ `hydra list`
