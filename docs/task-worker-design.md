# Task Worker Product Design

Status: product design for issue #191.

Issue: https://github.com/sudoprivacy/hydra/issues/191

This document defines how Hydra should support workers that are not bound to a
git repository, branch, or git worktree. It is the product contract for the
implementation that follows.

## Summary

Hydra workers should be generalized from "git worktree + tmux session + AI
agent" to "isolated AI execution unit with a workdir and lifecycle." A worker
always has a tmux session, an agent, a workdir, and lifecycle operations. A
worker does not always have a git repo, branch, or git worktree.

Hydra should expose two first-class worker types:

| Type | User-facing name | Workdir source | Git repo | Branch | Git worktree |
| --- | --- | --- | --- | --- | --- |
| Code worker | Code Worker | Hydra-managed git worktree | Yes | Yes | Yes |
| Task worker | Task Worker | User directory or Hydra-managed task directory | No | No | No |

Code workers preserve Hydra's existing coding workflow. Task workers expand the
same orchestration model to research, writing, document work, email triage,
data analysis, and other non-coding tasks.

## Resolved Product Decisions

- If `hydra worker create` is run inside a git repo without enough information
  to create a code worker, Hydra should ask for `--branch` instead of silently
  creating a task worker.
- If `hydra worker create` is run outside a git repo without `--repo`, `--dir`,
  or `--temp`, Hydra should create a task worker in the current directory.
- For `--dir`, `--name` may be omitted and defaults to the directory basename.
- For `--temp`, the MVP requires `--name`; deriving a stable name from `--task`
  can be added later.
- `delete` keeps task worker files by default. Only `--delete-files` may remove
  Hydra-managed temp task directories.
- UI copy should use "folder" or "workdir" for task workers, not "worktree."

## Goals

- Support creating workers without requiring a git repo or branch.
- Support arbitrary local directories as task worker workdirs.
- Support Hydra-managed temporary task directories.
- Preserve the full worker lifecycle for task workers:
  - create
  - logs
  - send
  - stop
  - start
  - delete
- Make task workers a first-class UI concept instead of showing them as
  `unknown` repos.
- Keep code worker behavior backward compatible.
- Avoid deleting user-owned directories by default.
- Give copilots clear rules for choosing between code workers and task workers.

## Non-Goals

- Do not change the existing git worktree isolation model for code workers.
- Do not require task worker directories to be git repositories.
- Do not add PR, branch, or git diff workflows to task workers in the initial
  implementation.
- Do not support sharing task workers in the first implementation.
- Do not introduce artifact browsing, task templates, or automatic final report
  generation in the first implementation.
- Do not allow workers to create other workers. The existing parent copilot rule
  still applies.

## Worker Concepts

### Code Worker

A code worker is the current Hydra worker model:

- Requires a repo.
- Requires a branch.
- Creates a git worktree.
- Runs an agent inside that worktree.
- Supports git status, review changes, branch rename, PR discovery, and current
  code-worker delete semantics.

Example:

```bash
hydra worker create --repo . --branch feat/new-flow --task "Implement the new flow"
```

### Task Worker

A task worker is a worker that runs in a plain directory:

- Requires a workdir.
- Does not require a repo.
- Does not require a branch.
- Does not create a git worktree.
- Runs an agent inside the selected workdir.
- Supports normal Hydra lifecycle operations.
- Is displayed separately from repo groups in the UI.

Examples:

```bash
hydra worker create --dir ~/Desktop/research --name market-research --task "Research competitors and write a summary"
hydra worker create --temp --name inbox-triage --task "Review the exported email notes and extract follow-ups"
```

## CLI Product Contract

`hydra worker create` should support two mutually exclusive modes.

### Code Worker Mode

```bash
hydra worker create --repo <path> --branch <branch> [--agent <agent>] [--task <prompt>] [--task-file <path>]
hydra worker create --branch <branch> [--agent <agent>] [--task <prompt>] [--task-file <path>]
```

Rules:

- When `--repo` is provided, `--branch` is required.
- `--repo` may be omitted when the command runs inside a git repository; Hydra
  should infer the current repo and still require `--branch`.
- Existing branch and worktree resume behavior remains unchanged.
- Existing output fields remain available for backward compatibility.

### Task Worker Mode

```bash
hydra worker create --dir <path> [--name <name>] [--agent <agent>] [--task <prompt>] [--task-file <path>]
hydra worker create --temp --name <name> [--agent <agent>] [--task <prompt>] [--task-file <path>]
```

Rules:

- `--dir` and `--temp` are mutually exclusive.
- `--repo` is mutually exclusive with `--dir` and `--temp`.
- `--branch` is not valid for task workers.
- `--name` replaces `--branch` as the task worker identity.
- For `--dir`, `--name` is optional. If omitted, Hydra derives the name from the
  directory basename and prints the resolved name in the command output.
- For `--temp`, `--name` is required in the MVP. If automatic task-name
  derivation is implemented later, the resolved name must be stable and printed
  in the command output.
- `--task` is recommended but not strictly required. Creating an interactive
  empty task worker should remain possible.
- `--task-file` should be copied into the task worker workdir using the same
  behavior as code workers.

### Default Create Behavior

When `hydra worker create` is called without `--repo`, `--dir`, or `--temp`:

- If the current directory is inside a git repo, Hydra should fail with a clear
  message telling the user to provide `--branch` for a code worker or `--dir` /
  `--temp` for a task worker.
- If the current directory is not inside a git repo, Hydra should default to a
  task worker in the current directory.
- The current-directory task worker should derive its name from the directory
  basename unless `--name` is provided.

This keeps code-worker branch creation explicit while making non-git directories
usable without extra ceremony.

### Delete Behavior

Task worker deletion must be conservative:

```bash
hydra worker delete <session>
hydra worker delete <session> --delete-files
```

Rules:

- For code workers, existing delete semantics remain unchanged:
  - kill session
  - remove worktree
  - delete branch
  - archive worker metadata
- For task workers created with `--dir`, delete must not remove the workdir.
- For task workers created with `--temp`, delete must not remove the workdir by
  default.
- `--delete-files` may remove a Hydra-managed temp workdir.
- `--delete-files` must not remove a user-provided `--dir` workdir unless a
  later product decision explicitly allows a separate force flag.

## CLI Output

Code worker output can remain branch-oriented:

```text
Worker created: hydra-abc123_feat-new-flow
  Type:     code
  Branch:   feat/new-flow
  Agent:    codex
  Workdir:  /Users/me/.hydra/worktrees/repo-abc123/feat-new-flow
  Session:  hydra-abc123_feat-new-flow
```

Task worker output should be task-oriented:

```text
Worker created: task-market-research
  Type:     task
  Name:     market-research
  Agent:    codex
  Workdir:  /Users/me/Desktop/research
  Session:  task-market-research
```

JSON output should include a stable worker type/source field, for example:

```json
{
  "status": "created",
  "type": "task",
  "session": "task-market-research",
  "name": "market-research",
  "agent": "codex",
  "workdir": "/Users/me/Desktop/research",
  "managedWorkdir": false
}
```

## VS Code Product Flow

The "Hydra: Create Worker" command should become a type-aware flow.

### When the Workspace Is a Git Repo

Show a worker type picker:

- Code Worker
- Task Worker

Code Worker flow:

1. Detect the current repo.
2. Prompt for branch.
3. Prompt for agent.
4. Optionally prompt for task.
5. Create git worktree and start the agent.

Task Worker flow:

1. Prompt for workdir source:
   - Current workspace folder
   - Choose local folder
   - Create Hydra-managed temp folder
2. Prompt for worker name.
3. Prompt for agent.
4. Prompt for task.
5. Start the agent in the selected workdir.

### When the Workspace Is Not a Git Repo

Default to Task Worker flow instead of failing.

Suggested flow:

1. Use current workspace folder as the default workdir.
2. Allow choosing another folder.
3. Allow creating a Hydra-managed temp folder.
4. Prompt for worker name, agent, and task.
5. Start the agent.

## Sidebar Product Model

The Workers view should separate repo-backed code workers from task workers.

Suggested tree:

```text
Workers
  hydra
    feat/new-flow
      running · codex
      git: M:2 A:1
  Local Tasks
    market-research
      running · codex
      ~/Desktop/research
    inbox-triage
      stopped · claude
      ~/.hydra/tasks/inbox-triage
```

Rules:

- Do not group task workers under `unknown`.
- Do not label task worker directories as worktrees.
- UI strings should use "workdir" or "folder" for task workers.
- Existing code worker repo grouping remains unchanged.
- The current workspace marker should work for both code worker workdirs and
  task worker workdirs.

### Context Menu

Code worker context menu:

- Review Changes
- Open Worktree or Open Folder
- Open Terminal
- Copy Path
- Remove

Task worker context menu:

- Open Folder
- Open Terminal
- Copy Path
- Stop or Resume
- Delete Worker
- Delete Worker and Files, only for Hydra-managed temp workdirs

Task workers should not show Review Changes in the first implementation. If a
task worker directory happens to be a git repo, Hydra should still treat it as a
task worker unless it was created through code worker mode.

## Copilot Product Flow

Copilot onboarding should teach both creation modes.

Suggested guidance:

```text
# Code task: use a code worker
hydra worker create --repo <path> --branch <branch> --task "<task>"

# Non-code task: use a task worker
hydra worker create --temp --name <task-name> --task "<task>"
hydra worker create --dir <path> --name <task-name> --task "<task>"
```

Decision rules for copilots:

- Use a code worker when the task requires code edits, tests, commits, PRs, or
  git diff review.
- Use a task worker when the task is research, writing, document organization,
  email triage, data analysis, or another non-code task.
- Use `--dir` when the task needs access to an existing local folder.
- Use `--temp` when the task is one-off and Hydra can own the workspace.
- Include a clear `--task` prompt whenever delegating work.

Workers still must not create other workers. If a worker reports that more
parallel work is needed, the parent copilot remains responsible for creating and
assigning additional workers.

## Lifecycle Semantics

Task workers should match existing worker lifecycle expectations:

| Command | Code worker | Task worker |
| --- | --- | --- |
| `create` | Create/resume branch worktree and launch agent | Create/select workdir and launch agent |
| `logs` | Capture tmux pane output | Capture tmux pane output |
| `send` | Send message to tmux session | Send message to tmux session |
| `stop` | Kill session and keep worktree | Kill session and keep workdir |
| `start` | Restart agent in worktree | Restart agent in workdir |
| `delete` | Remove session, worktree, branch, and state | Remove session and state; keep files by default |

Archive and restore should preserve task worker metadata. Restoring a task
worker should restart the agent in the original workdir if it still exists. If
the workdir no longer exists:

- For user-provided `--dir`, Hydra should fail with a clear error.
- For Hydra-managed `--temp`, Hydra may recreate the directory if product and
  implementation constraints allow it.

## Data Model Requirements

Implementation should add an explicit worker source/type instead of inferring
from missing repo fields.

Suggested shape:

```ts
type WorkerSource = 'repo' | 'directory';

interface WorkerInfo {
  source?: WorkerSource; // missing means 'repo' for backward compatibility
  sessionName: string;
  displayName: string;
  workerId: number;
  repo?: string | null;
  repoRoot?: string | null;
  branch?: string | null;
  slug: string;
  status: 'running' | 'stopped';
  attached: boolean;
  agent: string;
  workdir: string;
  managedWorkdir?: boolean;
  tmuxSession: string;
  createdAt: string;
  lastSeenAt: string;
  sessionId: string | null;
  agentSessionFile?: string | null;
  copilotSessionName: string | null;
}
```

Rules:

- Existing workers without `source` are repo/code workers.
- Task workers use `source: 'directory'`.
- Task workers created with `--dir` use `managedWorkdir: false`.
- Task workers created with `--temp` use `managedWorkdir: true`.
- `workdir` remains required for all workers.
- Code paths should branch on `source`, not on `repoRoot` truthiness alone.

## Naming

Product naming:

- User-facing type: Task Worker
- Sidebar group: Local Tasks
- Technical source field: `directory`
- CLI workdir flags: `--dir` and `--temp`
- CLI identity flag: `--name`

Avoid using "repo-free worker" as user-facing product language. It describes
the implementation constraint rather than the user value.

## Backward Compatibility

- Existing `hydra worker create --repo <path> --branch <branch>` must keep
  working.
- Existing sessions without `source` must load as code workers.
- Existing archive entries without `source` must restore as code workers.
- Existing JSON output fields should remain present for code workers.
- Any new fields should be additive.
- Existing code-worker delete behavior should not change.

## Implementation Milestones

Recommended order:

1. Add worker source metadata and backward-compatible session state loading.
2. Extract shared agent/tmux launch lifecycle from repo-specific worktree
   creation.
3. Add task worker creation in `SessionManager`.
4. Add CLI parsing and validation for `--dir`, `--temp`, `--name`, and
   `--delete-files`.
5. Update `logs`, `send`, `stop`, `start`, `delete`, and `restore` behavior for
   task workers.
6. Update VS Code create-worker flow.
7. Update sidebar grouping and context menus.
8. Update copilot onboarding, README, AGENTS, and Hydra skill docs.
9. Add smoke tests for task worker lifecycle.

## Acceptance Criteria

- A user can run:

  ```bash
  hydra worker create --dir /tmp/hydra-notes --name notes --task "Summarize these files"
  ```

  and then use `logs`, `send`, `stop`, `start`, and `delete` successfully.

- A user can run:

  ```bash
  hydra worker create --temp --name research --task "Research the topic and write notes"
  ```

  and Hydra creates a managed task workdir.

- Deleting a `--dir` task worker does not delete the directory.
- Deleting a `--temp` task worker does not delete the directory unless
  `--delete-files` is supplied.
- Running `hydra worker create` in a non-git directory creates a task worker in
  the current directory.
- Running `hydra worker create` in a git repo without `--branch` fails with a
  clear message.
- Code worker creation remains backward compatible.
- Task workers appear under Local Tasks in the sidebar.
- Task workers do not show branch, PR, worktree, or git review affordances.
- The UI uses "folder" or "workdir" rather than "worktree" for task workers.

## Test Coverage

Add smoke tests for:

- CLI task worker create with `--dir`.
- CLI task worker create with `--temp`.
- Default create behavior in a non-git directory.
- Default create behavior in a git repo without `--branch`.
- Task worker delete keeps user-provided directories.
- Task worker delete keeps managed directories by default.
- Task worker delete removes managed directories with `--delete-files`.
- Task worker start resumes in the same workdir.
- Existing code worker create smoke tests still pass.

Manual VS Code checks:

- Create Code Worker from a git workspace.
- Create Task Worker from a git workspace.
- Create Task Worker from a non-git workspace.
- Confirm sidebar grouping and context menu differences.
- Confirm task worker labels use "folder" or "workdir," not "worktree."
