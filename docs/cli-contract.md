# Hydra CLI Contract

This document is the compatibility contract for Hydra's CLI. The CLI is the
control-plane protocol used by copilots, workers, scripts, and the VS Code
extension, so command names, global flags, JSON fields, exit codes, and help
behavior should not change accidentally.

This contract documents current behavior. It does not redesign the commander
parser or add new commands.

## Compatibility Rules

- Keep `hydra --help`, `hydra help`, `hydra --version`, and `hydra -V` working
  without tmux, git, VS Code, or an existing `~/.hydra` state.
- Keep documented `hydra <command> --help` probes working without invoking the
  command action.
- Keep `--json`, `--quiet`, and `--no-interactive` as global options accepted
  before subcommands.
- Keep stdout-piped invocations machine friendly: when `stdout` is not a TTY,
  the CLI auto-enables `--json` and `--no-interactive`.
- Prefer JSON fields as the scripting interface. Human-readable text may evolve
  where JSON is already documented.
- Preserve hidden or legacy behavior until a PR explicitly calls out an
  intentional contract change.

## Global Invocation

| Form | Contract |
| --- | --- |
| `hydra [global-options] <command> [options]` | Run a named command. |
| `hydra --help`, `hydra -h` | Print top-level usage without command side effects. |
| `hydra help` | Print top-level usage without command side effects. |
| `hydra --version`, `hydra -V` | Print the package version. |

Global options:

| Option | Contract |
| --- | --- |
| `--json` | Print successful command payloads as one JSON object on stdout. Command failures handled by Hydra actions print a JSON error object on stderr. |
| `--quiet` | Suppress successful output. Errors still print to stderr. |
| `--no-interactive` | Disable interactive prompts and fail instead. This is also enabled automatically when stdout is not a TTY. |

Environment used by the CLI contract:

| Variable | Contract |
| --- | --- |
| `HYDRA_HOME` | Overrides the Hydra state directory. Tests should set this to isolate `sessions.json`, repo registry, archives, and logs. |
| `HYDRA_CONFIG_PATH` | Overrides the global CLI config file path. |
| `HYDRA_TMUX_SOCKET` | Overrides the tmux socket namespace used by Hydra. Tests should set this to avoid real user sessions. |
| `HYDRA_TELEMETRY=0` | Disables telemetry for smoke tests and scripted contract probes. |

## Exit Codes

Hydra action-level errors use the shared classifier in `src/cli/output.ts`.

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Internal or otherwise unclassified failure. JSON errors mark these as `retryable: true`. |
| `2` | Validation failure. |
| `4` | Not found. |
| `5` | Conflict or already-exists failure. |

## Error Shape

Hydra action-level failures under `--json` or piped stdout print one JSON object
to stderr:

```json
{
  "error": {
    "code": 2,
    "message": "Human-readable error message",
    "retryable": false,
    "hint": "Optional remediation hint"
  }
}
```

The `hint` field is optional. Parser-level commander errors are a current caveat
listed below.

## JSON Output

### `hydra list --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `copilots` | array | Copilot session entries. Empty when none are known. |
| `workers` | array | Worker session entries. Empty when none are known. |
| `count` | number | `copilots.length + workers.length`. |

Copilot entries include:

| Field | Type |
| --- | --- |
| `name` | string |
| `session` | string |
| `agent` | string |
| `mode` | string |
| `status` | string |
| `attached` | boolean |
| `workdir` | string or null |
| `sessionId` | string or null |
| `sessionFile` | string or null |
| `agentSessionId` | string or null |

Worker entries include:

| Field | Type |
| --- | --- |
| `number` | number or undefined |
| `name` | string |
| `type` | `"code"` or `"task"` |
| `session` | string |
| `repo` | string or null |
| `branch` | string or null |
| `agent` | string |
| `status` | string |
| `runtimeState` | object |
| `attached` | boolean |
| `workdir` | string or null |
| `managedWorkdir` | boolean |
| `copilotSessionName` | string or null |
| `sessionId` | string or null |
| `sessionFile` | string or null |
| `agentSessionId` | string or null |

`status` is the tmux/session lifecycle (`running` or `stopped`). `runtimeState`
is the current worker runtime projection. Its `state` is one of `unknown`,
`running`, `idle`, `needs-input`, or `error`; `complete` remains a notification
event and usually projects runtime to `idle`. When the tmux session is stopped,
`runtimeState.state` is reported as `unknown` so stale agent state is not shown
as current.

### `hydra config get default-agent --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `key` | string | `"default-agent"`. |
| `value` | string | Current default agent. Fallback is `"claude"`. |
| `source` | string | `"configured"` or `"fallback"`. |
| `path` | string | Effective config file path. |

`defaultAgent` and `default_agent` are accepted aliases for the same key in
commands that take a config key.

### `hydra events --json`

Reads the append-only local event stream in `HYDRA_HOME/events.jsonl`.
Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `events` | array | Event records with `seq` greater than `--after`, in ascending sequence order. |
| `count` | number | `events.length`. |
| `lastSeq` | number | Last printed event sequence, or the starting sequence when no events matched. |

Event records include:

| Field | Type |
| --- | --- |
| `version` | `1` |
| `seq` | number |
| `bootId` | string |
| `ts` | string |
| `type` | string |
| `source` | `"cli"`, `"extension"`, `"session-manager"`, or `"hook"` |
| `session` | string or undefined |
| `role` | `"worker"`, `"copilot"`, or undefined |
| `agent` | string or undefined |
| `workdir` | string or undefined |
| `payload` | object or undefined |

Current event types:

| Type | Source | Role | Payload contract |
| --- | --- | --- | --- |
| `notify.created` | `cli`, `extension`, `session-manager`, or `hook` | undefined | `notificationId`, `kind`, `title`, redacted `body`, `targetSession`, `sourceSession`, optional `actionType`, `actionSession`, `workerId`, `branch`, `workdir`, `agent`. Emitted only when a new notification is stored; dedupe hits do not emit a duplicate event. |
| `notify.read` | `cli`, `extension`, `session-manager`, or `hook` | undefined | Same notification reference fields as `notify.created`. Emitted only when the notification transitions from unread to read. |
| `notify.resolved` | `cli`, `extension`, `session-manager`, or `hook` | undefined | Notification reference fields plus `notificationStatus`, `resolvedAt`, and `reason`. Emitted only when an active occurrence transitions to resolved. |
| `notify.dismissed` | `cli`, `extension`, `session-manager`, or `hook` | undefined | Notification reference fields plus `notificationStatus`, `dismissedAt`, and `reason`. Emitted only when an active occurrence transitions to dismissed. |
| `notify.cleared` | `cli`, `extension`, `session-manager`, or `hook` | undefined | `cleared`, optional `session`, `targetSession`, `sourceSession`, `kind`. Emitted only when at least one notification is removed. |
| `worker.created` | `session-manager` | `worker` | `workerId`, `source`, optional `branch`, `repo`, `managedWorkdir`. Emitted for fresh code/task worker creation. |
| `worker.started` | `session-manager` | `worker` | Worker identity fields plus `resumed`; existing-branch paths also include `alreadyRunning`. Emitted when an existing worker session is started or reused. |
| `worker.runtime.changed` | `cli`, `extension`, `session-manager`, or `hook` | `worker` | `state`, optional `previousState`, `origin`, `reason`, `notificationId`, `workerId`, `updatedAt`. Emitted when the durable worker runtime projection changes. |
| `worker.stopped` | `session-manager` | `worker` | Worker identity fields. |
| `worker.deleted` | `session-manager` | `worker` | Worker identity fields plus `archived`, `deletedFiles`, `removedWorktree`, `deletedBranch`. |
| `worker.restored` | `session-manager` | `worker` | Worker identity fields plus `archivedAt`. |
| `copilot.created` | `session-manager` | `copilot` | `copilotMode`. Emitted for fresh copilot creation. |
| `copilot.started` | `session-manager` | `copilot` | `copilotMode`, `resumed`. Emitted when an existing copilot session is started. |
| `copilot.deleted` | `session-manager` | `copilot` | `copilotMode`, `archived`. |
| `copilot.restored` | `session-manager` | `copilot` | `copilotMode`, `archivedAt`. |
| `session.id.captured` | `session-manager` | `worker` or `copilot` | `hasSessionId`, `hasAgentSessionFile`. |

Payloads are sanitized before writing. Keys that may carry prompt, message,
body, diff, content, token, credential, password, authorization, API key, or
private key data are redacted.

`--after <seq>` returns only events with a larger `seq`.

`--cursor-file <path>` reads the starting sequence from a file when `--after`
is omitted and updates the file after printing events. Cursor files contain the
last printed sequence as plain text.

### `hydra events --follow --json`

Streams new event records as JSON lines until interrupted. Each stdout line is
one event record, not a wrapper object. `--after` and `--cursor-file` have the
same meaning as non-follow mode; the cursor file is updated after each printed
event.

The event log rotates the active `events.jsonl` into bounded sequence-named
segments. `EventLog.read()` reads retained segments transparently and preserves
monotonic `seq` values through `events.state.json`; consumers must track by
`seq`, not filename or byte offset. The default retention keeps up to 16
segments of 4 MiB each for at most 30 days.

### `hydra notify create --json`

Creates a structured local notification in `HYDRA_HOME/notifications.json`.
Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"created"` for a new notification, `"exists"` for an idempotent dedupe hit. |
| `created` | boolean | Whether a new notification was written. |
| `notification` | object | The stored notification record. |

Notification records include:

| Field | Type |
| --- | --- |
| `id` | string |
| `createdAt` | string |
| `readAt` | string or null |
| `kind` | `"complete"`, `"needs-input"`, `"error"`, `"blocked"`, or `"info"` |
| `title` | string |
| `body` | string |
| `targetSession` | string or null |
| `sourceSession` | string or null |
| `dedupeKey` | string or undefined |
| `action` | object or undefined |
| `context` | object or undefined |

`--dedupe-key` is an idempotency key. When it matches an existing notification,
the command returns the existing record and does not append a duplicate.
`complete`, `needs-input`, and `error` notifications also update
`HYDRA_HOME/worker-runtime-state.json` for the `sourceSession`; reading,
opening, or clearing notifications does not clear runtime state.

### `hydra notify list --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `notifications` | array | Matching notification records, newest first. |
| `count` | number | `notifications.length`. |
| `unreadCount` | number | Total unread notifications in the store, before filters. |
| `totalCount` | number | Total notifications in the store, before filters. |

Supported filters include `--session`, `--target`, `--from`, `--kind`,
`--unread`, and `--limit`.

### `hydra notify read <id> --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `notification` | object | The notification after the read operation. |
| `markedRead` | number | `1` if the command changed unread to read, otherwise `0`. |

Reading changes only `readAt`; it does not resolve or dismiss the occurrence
and does not change worker runtime.

### `hydra notify resolve <id> --reason <text> --json`

Resolves one active notification occurrence. This is primarily an automation
and lifecycle command; normal agent transitions resolve attention themselves.

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `notificationStatus` | string | The durable occurrence status after the operation. |
| `changed` | boolean | Whether the occurrence changed from active to resolved. |
| `notification` | object | The compatibility notification projection. |

Resolving records the supplied reason and removes the occurrence from active
inbox projections. The command does not mutate worker runtime directly.

### `hydra notify dismiss <id> --json`

Dismisses one notification occurrence without changing worker runtime.

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `notificationStatus` | string | The durable occurrence status after the operation. |
| `changed` | boolean | Whether the occurrence changed from active to dismissed. |
| `notification` | object | The compatibility notification projection. |

### `hydra notify clear --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `cleared` | number | Number of notifications removed. |

`--session`, `--target`, `--from`, and `--kind` narrow which notifications are cleared.
With no filter, all notifications are cleared.

### `hydra notify open <id> --json`

Returns notification data and marks the notification read. This MVP does not
focus VS Code UI directly; callers should inspect `action`.

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `opened` | boolean | Always `false` until a UI-backed opener is added. |
| `notification` | object | The notification after the open operation. |
| `action` | object or null | Suggested follow-up action, such as `open-session`. |
| `markedRead` | number | `1` if the command changed unread to read, otherwise `0`. |

### `hydra worker logs <session> --json`

Returns:

| Field | Type |
| --- | --- |
| `session` | string |
| `lines` | number |
| `output` | string |
| `sessionId` | string or null |
| `sessionFile` | string or null |

### `hydra copilot logs <session> --json`

Returns the same fields as worker logs:

| Field | Type |
| --- | --- |
| `session` | string |
| `lines` | number |
| `output` | string |
| `sessionId` | string or null |
| `sessionFile` | string or null |

## Command Families

Worker commands:

| Command | Contract |
| --- | --- |
| `worker create` | Create or resume a code worker with `--repo` and `--branch`, or create a task worker with `--dir`, `--temp`, and `--name`. |
| `worker delete <session>` | Delete a worker. `--delete-files` only deletes Hydra-managed temp task folders. |
| `worker stop <session>` | Kill the tmux session while keeping the workdir. |
| `worker start <session>` | Start a stopped worker. |
| `worker rename <session> <new-branch>` | Rename a code worker. |
| `worker logs <session>` | Capture terminal output. Supports `--lines <n>`. |
| `worker send <session> <message>` | Send text to one worker. `--all` broadcasts to running workers and treats the first positional argument as the message. |

Copilot commands:

| Command | Contract |
| --- | --- |
| `copilot create` | Create a copilot in `--workdir` or registered `--repo`. Supports `--agent`, `--mode`, `--plan`, `--name`, and `--session`. |
| `copilot delete <session>` | Delete a copilot and archive metadata. |
| `copilot restore <session>` | Restore an archived copilot by session name. |
| `copilot rename <session> <new-name>` | Rename a copilot session. |
| `copilot logs <session>` | Capture terminal output. Supports `--lines <n>`. |
| `copilot send <session> <message>` | Send text to a copilot. |

Config commands:

| Command | Contract |
| --- | --- |
| `config list` | Print effective CLI settings. Supports `--json`. |
| `config get <key>` | Print one setting. Currently supports `default-agent`. |
| `config set <key> <value>` | Persist one setting. Currently supports `default-agent`. |
| `config unset <key>` | Remove one setting and fall back to defaults. |

Notify commands:

| Command | Contract |
| --- | --- |
| `notify create` | Create a structured local notification. Supports `--session`, `--from`, `--kind`, `--title`, `--body`, `--dedupe-key`, `--action`, and context flags. |
| `notify list` | List structured notifications. Supports `--session`, `--target`, `--from`, `--kind`, `--unread`, and `--limit`. |
| `notify read <id>` | Mark one notification read. |
| `notify resolve <id>` | Resolve one occurrence with a required lifecycle reason; does not directly mutate runtime. |
| `notify dismiss <id>` | Dismiss one occurrence without changing runtime. |
| `notify clear` | Clear all notifications, or a narrowed session/source/target/kind subset. |
| `notify open <id>` | Mark one notification read and return its suggested action. |

Events command:

| Command | Contract |
| --- | --- |
| `events` | Read `HYDRA_HOME/events.jsonl`. Supports `--after`, `--follow`, and `--cursor-file`. |

Archive commands:

| Command | Contract |
| --- | --- |
| `archive list` | List archived sessions. `--all` includes duplicate history entries. |
| `archive view <session>` | Show full archive history for one session. |
| `archive restore <session>` | Restore the latest archived worker or copilot entry. |

## No-State Help Probes

The following probes are executable contract checks. They must exit 0 and print
the expected text without tmux, git, VS Code, or a populated `~/.hydra`.

<!-- cli-contract-help-probes:start -->
- `hydra --help` -> `Usage: hydra [options] [command]`
- `hydra --help` -> `CLI for managing Hydra copilots and workers`
- `hydra help` -> `Usage: hydra [options] [command]`
- `hydra --version` -> package version
- `hydra worker create --help` -> `Usage: hydra worker create [options]`
- `hydra worker delete --help` -> `Usage: hydra worker delete [options] <session>`
- `hydra worker logs --help` -> `Usage: hydra worker logs [options] <session>`
- `hydra worker send --help` -> `Usage: hydra worker send [options] <session> <message>`
- `hydra copilot create --help` -> `Usage: hydra copilot create [options]`
- `hydra copilot restore --help` -> `Usage: hydra copilot restore [options] <session>`
- `hydra copilot logs --help` -> `Usage: hydra copilot logs [options] <session>`
- `hydra copilot send --help` -> `Usage: hydra copilot send [options] <session> <message>`
- `hydra config get --help` -> `Usage: hydra config get [options] <key>`
- `hydra events --help` -> `Usage: hydra events [options]`
- `hydra notify create --help` -> `Usage: hydra notify create [options]`
- `hydra notify list --help` -> `Usage: hydra notify list [options]`
- `hydra notify read --help` -> `Usage: hydra notify read [options] <id>`
- `hydra notify resolve --help` -> `Usage: hydra notify resolve [options] <id>`
- `hydra notify dismiss --help` -> `Usage: hydra notify dismiss [options] <id>`
- `hydra notify clear --help` -> `Usage: hydra notify clear [options]`
- `hydra notify open --help` -> `Usage: hydra notify open [options] <id>`
<!-- cli-contract-help-probes:end -->

## Current Caveats

These are current contracts to preserve until a follow-up PR intentionally
changes them:

- Commander parser errors, such as missing positional arguments or unknown
  commands, are emitted by commander itself as plain text and currently do not
  use Hydra's JSON error shape.
- `--no-interactive` is a global option, but most worker/copilot commands do not
  need prompts today. Repo removal is the primary command path that consumes the
  interactive flag.
- `--quiet` suppresses successful output only. It does not suppress errors.

## Smoke Coverage

`npm run smoke:cli-contract` executes the current contract probes against the
compiled CLI at `out/cli/index.js`. It isolates `HOME`, `HYDRA_HOME`,
`HYDRA_CONFIG_PATH`, and `HYDRA_TMUX_SOCKET`, and disables telemetry with
`HYDRA_TELEMETRY=0`.

`npm run test` includes this smoke so CLI contract regressions are caught with
the rest of the repository smoke suite.
