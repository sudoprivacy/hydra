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
| `attached` | boolean |
| `workdir` | string or null |
| `managedWorkdir` | boolean |
| `copilotSessionName` | string or null |
| `sessionId` | string or null |
| `sessionFile` | string or null |
| `agentSessionId` | string or null |

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

### `hydra notify clear --json`

Returns:

| Field | Type | Contract |
| --- | --- | --- |
| `status` | string | `"ok"`. |
| `cleared` | number | Number of notifications removed. |

`--session`, `--target`, and `--from` narrow which notifications are cleared.
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
| `notify clear` | Clear all notifications, or a narrowed session/source/target subset. |
| `notify open <id>` | Mark one notification read and return its suggested action. |

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
- `hydra notify create --help` -> `Usage: hydra notify create [options]`
- `hydra notify list --help` -> `Usage: hydra notify list [options]`
- `hydra notify read --help` -> `Usage: hydra notify read [options] <id>`
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
