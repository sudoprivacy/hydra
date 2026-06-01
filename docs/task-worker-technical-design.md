# Task Worker Technical Design

Status: technical design for issue #191.

Product design: [task-worker-design.md](./task-worker-design.md)

Issue: https://github.com/sudoprivacy/hydra/issues/191

## Summary

Task workers should be implemented by adding an explicit worker source and by
splitting repo/worktree setup from the shared tmux + agent launch lifecycle.
The current worker implementation has three responsibilities coupled inside
`SessionManager.createWorker()`:

1. Resolve a git repo, branch, base branch, slug, and worktree path.
2. Create or resume the git worktree.
3. Create a tmux session, launch the agent, persist worker state, capture the
   agent session id, and send the initial task.

The implementation should keep the repo-specific code path intact for code
workers, add a directory-specific preparation path for task workers, and reuse a
single launch/persist path for both.

## Design Constraints

- Preserve existing code worker behavior and CLI compatibility.
- Existing workers without a source field must continue to behave as code
  workers.
- Do not infer worker type from missing repo fields once new state is written.
  Use an explicit source field.
- Do not delete user-provided task worker directories.
- Do not display task workers as `unknown` repos.
- Do not add git affordances to task workers in the first implementation.
- Keep path comparisons based on normalized absolute paths with `~` expansion;
  do not introduce `realpath` as the primary equality check.

## Data Model

Add a worker source/type and make repo-specific fields nullable.

```ts
export type WorkerSource = 'repo' | 'directory';

export interface WorkerInfo {
  source?: WorkerSource; // undefined means 'repo' for backward compatibility
  sessionName: string;
  displayName: string;
  workerId: number;
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
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

Helper functions should centralize source checks:

```ts
function getWorkerSource(worker: WorkerInfo): WorkerSource {
  return worker.source ?? 'repo';
}

function isRepoWorker(worker: WorkerInfo): boolean {
  return getWorkerSource(worker) === 'repo';
}

function isDirectoryWorker(worker: WorkerInfo): boolean {
  return getWorkerSource(worker) === 'directory';
}
```

Rules:

- New code workers write `source: 'repo'`.
- New task workers write `source: 'directory'`.
- Existing session and archive entries with no `source` are treated as repo
  workers.
- Directory workers created with `--dir` write `managedWorkdir: false`.
- Directory workers created with `--temp` write `managedWorkdir: true`.
- Code workers may omit `managedWorkdir` or write `false`; cleanup is governed
  by `source`, not by `managedWorkdir`.

## Path Helpers

Add a task-directory root next to existing Hydra paths:

```ts
hydraTasksRoot: path.join(hydraHome, 'tasks')
```

Suggested exported helpers in `src/core/path.ts`:

```ts
export function getHydraTasksRoot(): string;
export function expandAndResolvePath(input: string): string;
```

The implementation can reuse existing path normalization helpers, but it should
avoid spreading `~` expansion and absolute-path normalization across CLI and
SessionManager call sites.

Task worker workdir rules:

- `--dir <path>` resolves to an absolute path.
- If `--dir` does not exist, create it with `mkdir -p` semantics.
- If `--dir` exists and is not a directory, fail.
- `--dir` always records `managedWorkdir: false`, even when Hydra created the
  missing directory at the user's requested path.
- `--temp --name <name>` resolves to
  `<hydraTasksRoot>/<task-slug>`.
- If a temp task directory already exists, fail with a message asking for a
  different `--name` or manual cleanup. Do not reuse it implicitly.

## Name and Slug Handling

Add a task-worker name validator separate from git branch validation.

Suggested behavior:

```ts
function normalizeTaskWorkerName(name: string, backend: MultiplexerBackendCore): string {
  const slug = backend.sanitizeSessionName(name.trim());
  if (!slug) throw new Error('Task worker name is required.');
  return slug;
}
```

Rules:

- Do not run `validateBranchName()` for task workers.
- For `--dir` without `--name`, derive the input name from
  `path.basename(workdir)`.
- For default current-directory task workers, derive the name from the current
  directory basename.
- For `--temp`, require `--name` in the MVP.
- Use the normalized slug as `displayName` for consistency with existing worker
  display behavior.
- A task worker name collision should fail clearly instead of adding an
  automatic numeric suffix. Users can choose a different `--name`.

## Session Names

Use a stable namespace for task workers:

```ts
const TASK_WORKER_SESSION_NAMESPACE = 'task';
const sessionName = backend.buildSessionName(TASK_WORKER_SESSION_NAMESPACE, slug);
```

With the current tmux backend this produces names like
`task_market-research`.

Before creating a task worker, check for collisions in:

- `sessions.json` workers
- `sessions.json` copilots
- live backend sessions

If the session name already exists, fail with:

```text
Task worker "<name>" already exists. Use a different --name or start/delete the existing worker.
```

Archived task workers are restored through the archive command, not by creating
a new worker with the same name.

## Public SessionManager API

Keep the existing `createWorker()` name as the repo/code-worker API to minimize
call-site churn, but introduce clearer typed aliases internally.

Suggested interfaces:

```ts
export interface CreateRepoWorkerOpts {
  repoRoot: string;
  branchName: string;
  agentType?: string;
  baseBranchOverride?: string;
  task?: string;
  taskFile?: string;
  agentCommand?: string;
  resumeSessionId?: string;
  resumeSessionFile?: string | null;
  copilotSessionName?: string;
  notifyCopilot?: boolean;
  preservedWorkerInfo?: WorkerInfo;
  fetchMode?: 'best-effort' | 'required';
}

export interface CreateDirectoryWorkerOpts {
  workdir: string;
  name?: string;
  managedWorkdir?: boolean;
  agentType?: string;
  task?: string;
  taskFile?: string;
  agentCommand?: string;
  resumeSessionId?: string;
  resumeSessionFile?: string | null;
  copilotSessionName?: string;
  notifyCopilot?: boolean;
  preservedWorkerInfo?: WorkerInfo;
}

export interface DeleteWorkerOpts {
  deleteFiles?: boolean;
}
```

Methods:

```ts
async createWorker(opts: CreateRepoWorkerOpts): Promise<CreateWorkerResult>;
async createRepoWorker(opts: CreateRepoWorkerOpts): Promise<CreateWorkerResult>;
async createDirectoryWorker(opts: CreateDirectoryWorkerOpts): Promise<CreateWorkerResult>;
async deleteWorker(sessionName: string, opts?: DeleteWorkerOpts): Promise<void>;
```

`createWorker()` should delegate to `createRepoWorker()` for backward
compatibility.

## Shared Worker Launch Pipeline

Extract the common launch sequence from `createWorker()`, `startWorker()`, and
eventually `createCopilot()` only as far as needed for this feature. Do not do a
large copilot refactor as part of the task worker implementation.

Suggested internal shape:

```ts
interface PreparedWorkerLaunch {
  source: WorkerSource;
  sessionName: string;
  displayName: string;
  slug: string;
  workdir: string;
  repo: string | null;
  repoRoot: string | null;
  branch: string | null;
  managedWorkdir: boolean;
  agentType: string;
  agentCommand: string;
  task?: string;
  resumeSessionId?: string;
  resumeSessionFile?: string | null;
  copilotSessionName?: string;
  notifyCopilot: boolean;
  preservedWorkerInfo?: WorkerInfo;
  preservedStateKey?: string;
}

private async launchPreparedWorker(prepared: PreparedWorkerLaunch): Promise<CreateWorkerResult>;
```

`launchPreparedWorker()` owns:

1. Completion-hook injection.
2. `backend.createSession()`.
3. `backend.setSessionWorkdir()`.
4. `backend.setSessionRole('worker')`.
5. `backend.setSessionAgent()`.
6. Fresh or resume agent launch.
7. Initial `sessions.json` write.
8. Post-create readiness wait.
9. Session id capture.
10. Initial task send.

Repo-specific preparation owns:

- branch validation
- fetch
- base branch detection
- slug collision resolution
- `git worktree add`
- Windows symlink repair
- instruction import resolution

Directory-specific preparation owns:

- workdir resolution and creation
- task name validation
- temp directory creation
- task session name collision checks

This split prevents task workers from duplicating agent startup logic.

## Task File Handling

Move task-file copying into a helper used by both worker sources:

```ts
private prepareTaskFile(
  workdir: string,
  task: string | undefined,
  taskFile: string | undefined,
  source: WorkerSource,
  defaultPromptVerb: 'implement' | 'complete',
): { task?: string; taskFilename?: string }
```

Rules:

- Resolve relative `--task-file` from the CLI process cwd.
- If the file does not exist:
  - code workers preserve existing behavior for compatibility
  - task workers fail with `Task file "<path>" not found`
- Copy the task file into the worker workdir.
- If source and target are the same absolute path, skip the copy.
- If no `--task` was supplied:
  - code worker prompt: `Read the task in \`<file>\` and implement it.`
  - task worker prompt: `Read the task in \`<file>\` and complete it.`

## Instruction Imports

Keep existing `@import` resolution for code workers only.

Do not run `resolveImports()` against user-provided task worker directories in
the MVP. It mutates instruction files, and arbitrary user folders are not
Hydra-managed worktrees.

Completion-hook injection may still write agent config under the task workdir
when `notifyCopilot` is enabled. This mirrors existing code-worker behavior and
is needed for completion notifications. Users can opt out with
`--no-notify-copilot`.

## Completion Notifications

The current notification script is branch-oriented. Refactor notification
metadata so task workers do not report a fake branch.

Suggested metadata:

```ts
interface WorkerNotificationInfo {
  copilotSessionName: string;
  sessionName: string;
  workerId: number;
  displayName: string;
  source: WorkerSource;
  branch?: string | null;
  workdir: string;
}
```

Rules:

- Code worker completion message includes branch.
- Task worker completion message includes task name and workdir.
- `withCodexCompletionHookOverrides()` should accept a list of trusted roots:
  - code worker: `[repoRoot, workdir]`
  - task worker: `[workdir]`

## CLI Changes

Update `src/cli/commands/worker.ts`.

### `worker create`

Change required options to optional options:

```ts
.option('--repo <path>', 'Path to the repository')
.option('--branch <name>', 'Branch name for a code worker')
.option('--dir <path>', 'Directory for a task worker')
.option('--temp', 'Create a Hydra-managed temporary task directory')
.option('--name <name>', 'Task worker name')
```

Mode resolution:

1. Reject `--repo` with `--dir` or `--temp`.
2. Reject `--branch` with `--dir` or `--temp`.
3. Reject `--base` with `--dir` or `--temp`.
4. Reject `--name` with code-worker mode.
5. If `--temp`, require `--name` and create a managed directory worker.
6. Else if `--dir`, create an unmanaged directory worker.
7. Else if `--repo` or `--branch`, create a code worker:
   - If `--repo` is omitted, infer the current git repo.
   - Require `--branch`.
8. Else if current directory is inside a git repo, fail with a clear message:

   ```text
   Current directory is a git repository. Provide --branch for a code worker, or use --dir/--temp for a task worker.
   ```

9. Else create an unmanaged directory worker in the current directory.

This makes `hydra worker create --branch feat/x --task "..."`
work from inside a git repo while preserving the explicit branch requirement.

### `worker delete`

Add:

```ts
.option('--delete-files', 'Delete Hydra-managed task worker files')
```

Pass `{ deleteFiles: opts.deleteFiles }` to `SessionManager.deleteWorker()`.

### Output

Include:

- `type`
- `name`
- `managedWorkdir`

For code workers keep existing `branch` output for compatibility.

## Lifecycle Behavior

### Start

`startWorker()` mostly works for both sources because it starts the saved worker
inside `existingWorker.workdir`. Required changes:

- Error text should say `Workdir "<path>" does not exist` instead of
  `Worktree`.
- If a directory worker has `managedWorkdir: true` and the workdir is missing,
  the implementation may recreate the directory before starting. The MVP can
  choose to fail clearly instead; product acceptance only requires restore
  semantics to be clear.
- Do not add git-specific behavior to task workers.

### Stop

No source-specific changes needed.

### Delete

`deleteWorker()` must branch by source.

Repo worker:

- Existing behavior:
  - kill session
  - remove worktree
  - delete branch
  - archive after destructive cleanup succeeds
  - remove state

Directory worker:

- Kill session, treating already-absent sessions as success.
- Archive metadata.
- If `deleteFiles`:
  - only proceed when `managedWorkdir === true`
  - remove the workdir with `fs.rm({ recursive: true, force: true })`
  - if removal fails, keep the worker state as stopped and rethrow
- If no `deleteFiles`, do not remove the workdir.
- Remove state after any requested cleanup succeeds.

If `--delete-files` is used on an unmanaged `--dir` task worker, fail with:

```text
Worker "<session>" uses a user-provided directory. --delete-files is only supported for Hydra-managed task workers.
```

### Rename

Keep `worker rename` code-worker-only in the MVP.

If called on a task worker, fail with:

```text
Worker "<session>" is a task worker. Branch rename is only available for code workers.
```

Task worker rename can be a later feature.

### Restore

`restoreWorker()` must branch by archived worker source:

- Repo worker: current `createWorker({ repoRoot, branchName, ... })` path.
- Directory worker:
  - if `workdir` exists, call `createDirectoryWorker()` with preserved worker
    metadata and resume session details
  - if missing and `managedWorkdir === true`, either recreate it or fail clearly
    in MVP
  - if missing and `managedWorkdir !== true`, fail clearly

Preserved task workers should reuse their original `sessionName`, `workerId`,
`createdAt`, `displayName`, and `slug`.

## Sync and Discovery

Update `sync()` reconciliation:

- Existing workers without `source` are repo workers.
- Repo workers keep current orphan behavior when tmux is gone and workdir is
  missing.
- Directory workers should not be deleted from state merely because the workdir
  is missing. Mark them stopped and let `startWorker()` produce a clear workdir
  error.

Update live-session discovery:

- If a live worker session has a workdir that resolves to a managed repo
  worktree marker, create a repo worker entry as today.
- If no repo root can be resolved, create a directory worker entry with:
  - `source: 'directory'`
  - `repo: null`
  - `repoRoot: null`
  - `branch: null`
  - `managedWorkdir: false`

This prevents discovered task-like sessions from appearing under `unknown`.

## Sidebar Changes

Update `src/providers/tmuxSessionProvider.ts`.

Recommended shape:

- Add `LocalTasksGroupItem`.
- Add task-specific item context values:
  - `taskWorkerItem`
  - `inactiveTaskWorkerItem`
- Split workers before grouping:
  - repo workers by `repoRoot`
  - directory workers under one Local Tasks group

Repo worker build path:

- Existing PR status fetch.
- Existing git status and branch labels.
- Existing git status child item.
- Existing `workerItem` / `inactiveWorkerItem` context values.

Task worker build path:

- Do not fetch PR statuses.
- Do not call git status helpers, even if the task workdir is inside a git repo.
- Use task name or slug as the label.
- Show folder/workdir in the detail line.
- Set `hasGit` false for menu purposes.
- Use task-specific context values so `Review Changes` is hidden.

Package menu changes:

- `tmux.reviewChanges`: only `workerItem` and `inactiveWorkerItem`.
- `tmux.openWorktree`: rename command title to "Open Folder" or add a task-safe
  alias. The existing implementation can still call `openWorktree()` internally
  until names are cleaned up.
- `tmux.copyPath`, `tmux.attach`, and `tmux.removeTask`: include task worker
  context values.

Internal variable names such as `worktreePath` can be migrated gradually. UI
copy should use "folder" or "workdir" for task workers in this feature.

## VS Code Create Worker Flow

Update `src/commands/newTask.ts`.

Suggested implementation:

1. Ensure backend is installed.
2. Detect whether current workspace is inside a git repo.
3. Block nested worker creation as today.
4. If in a git repo, show worker type picker:
   - Code Worker
   - Task Worker
5. If not in a git repo, default to Task Worker flow.

Code Worker flow:

- Existing branch input.
- Existing agent picker.
- Existing `SessionManager.createWorker()` call.

Task Worker flow:

- Workdir source quick pick:
  - Current workspace folder
  - Choose local folder
  - Create Hydra-managed temp folder
- Name input:
  - default to selected folder basename for current/choose-folder
  - required for temp
- Agent picker.
- Task prompt input.
- `SessionManager.createDirectoryWorker()`.
- Attach session in editor area as worker.

The first implementation can keep task prompt optional, but the UI should make
it natural to provide one.

## Context Menu Commands

Update `src/commands/contextMenu.ts` and `treeItemResolver.ts` as needed.

Short-term:

- Continue resolving paths through the existing `resolveWorktreePath()` helper.
- Add aliases or comments that treat this as a generic workdir for task worker
  items.

Behavior changes:

- `reviewChanges()` remains git/code-worker-only through menu visibility.
- `openWorktree()` user-facing title becomes "Open Folder".
- `removeTask()` confirmation text should branch by worker source:
  - code worker: mention session + worktree
  - task worker unmanaged: mention session only; files are kept
  - task worker managed: offer ordinary delete; a separate delete-files command
    or CLI flag handles file removal

## Share, Whoami, and List

### List

Update `src/cli/commands/list.ts`:

- JSON worker entries include `type`, `name`, and `managedWorkdir`.
- Pretty output groups task workers under `Local Tasks`.
- Pretty output avoids branch parentheses for task workers.

### Whoami

Update `src/cli/commands/whoami.ts`:

- Print `Type: code` or `Type: task`.
- Print branch/repo only for code workers.
- Print name/workdir for task workers.

### Share

Task worker sharing is a non-goal for the first implementation.

Update share creation to fail early for directory workers:

```text
Task workers cannot be shared yet.
```

This is safer than generating partial bundles with null repo metadata.

## Telemetry

Keep telemetry path-free.

Add worker source to existing events:

- `worker_created`: `{ agent, workerType: 'code' | 'task' }`
- `worker_resumed`: `{ agent, workerType: 'code' | 'task' }`
- `worker_deleted`: `{ workerType: 'code' | 'task', deleteFiles?: boolean }`

Do not include workdir, repo path, branch name, or task name.

## Documentation Updates

After implementation, update:

- `AGENTS.md`
- `README.md`
- `skills/hydra/SKILL.md`
- Copilot onboarding in `src/commands/createCopilot.ts`
- CLI help strings

Docs should use:

- Code Worker
- Task Worker
- Local Tasks
- folder/workdir for task worker directories

Avoid user-facing "repo-free worker" terminology.

## Test Plan

Add focused smoke tests rather than broad e2e coverage first.

Suggested new file:

```text
src/smoke/taskWorkerSmoke.ts
```

Test cases:

- `createDirectoryWorker()` with unmanaged `workdir`.
- `createDirectoryWorker()` with managed temp workdir.
- CLI create in a non-git directory defaults to a task worker.
- CLI create in a git repo without `--branch` fails with the required message.
- CLI create with `--branch` and no `--repo` inside a git repo uses the current
  repo.
- `deleteWorker()` keeps unmanaged directories.
- `deleteWorker()` keeps managed directories by default.
- `deleteWorker({ deleteFiles: true })` removes managed directories.
- `deleteWorker({ deleteFiles: true })` rejects unmanaged directories.
- `startWorker()` restarts a task worker in the saved workdir.
- `restoreWorker()` handles archived task worker metadata.
- Existing repo worker smoke tests still pass.

Use fake or stub backends where possible to avoid long-lived real agent
processes. Reuse existing smoke-test patterns for session state setup and fake
tmux behavior.

Manual checks:

- Create Code Worker from a git workspace.
- Create Task Worker from a git workspace.
- Create Task Worker from a non-git workspace.
- Confirm Local Tasks grouping.
- Confirm Review Changes is unavailable for task workers.
- Confirm Open Folder, Copy Path, Attach, Stop/Start, and Delete work.

Verification commands:

```bash
npm run compile
npm run lint
```

## Implementation Order

1. Add `WorkerSource`, nullable repo fields, source helpers, and path helpers.
2. Add directory worker preparation and session-name collision checks.
3. Extract `launchPreparedWorker()` from the existing repo worker create path.
4. Route repo worker creation through the shared launch helper with no behavior
   changes.
5. Implement `createDirectoryWorker()`.
6. Update delete/start/restore/sync behavior for directory workers.
7. Update CLI create/delete/list/whoami/share behavior.
8. Update VS Code create-worker flow.
9. Update sidebar grouping and context values.
10. Update context menu text and package menu conditions.
11. Update docs and copilot onboarding.
12. Add smoke tests and run compile/lint.

## Risks and Mitigations

### Risk: accidental user file deletion

Mitigation:

- `managedWorkdir` gates file deletion.
- `--delete-files` rejects unmanaged task workers.
- Default delete keeps files for all task workers.

### Risk: task workers inherit git UI because their folder is a repo

Mitigation:

- Sidebar and menu behavior branches on `source`, not `isGitInitialized()`.
- Task workers do not call PR or git status helpers.

### Risk: agent hook injection mutates arbitrary user folders

Mitigation:

- Only inject completion hooks when notification is enabled.
- Preserve `--no-notify-copilot`.
- Do not run instruction import rewriting for directory workers.

### Risk: session name collisions

Mitigation:

- Task worker create fails on collisions.
- Error message asks user to choose another `--name` or manage the existing
  worker.

### Risk: broad refactor destabilizes copilots

Mitigation:

- Extract only worker launch code needed for this feature.
- Leave copilot lifecycle refactors out of scope unless a helper is already
  shared safely.

### Risk: backward compatibility gaps in archived workers

Mitigation:

- Treat missing `source` as repo.
- Add restore tests for old repo-shaped workers and new task workers.
