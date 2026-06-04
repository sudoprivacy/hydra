# Hydra Logging Product and Technical Design

Status: product and technical design for issue #213.

Issue: https://github.com/sudoprivacy/hydra/issues/213

## Summary

Hydra needs a dedicated runtime logging system for extension and CLI failures.
Today, a failed copilot or worker startup usually leaves the user with only a
VS Code toast or CLI stderr. If the failure happens before the tmux/psmux
session and agent process are running, `hydra worker logs` and agent transcript
files do not exist yet. Debugging then depends on screenshots or VS Code
Extension Host logs, which are hard for users to find and do not consistently
capture Hydra-specific context.

The first implementation should add a small, always-on diagnostic log that is
easy to find, safe to share, and cheap enough to use in every normal Hydra
session.

## Goals

- Give users one Hydra-owned log file they can send after startup failures.
- Mirror important log entries into a VS Code Output channel named `Hydra`.
- Capture enough context to diagnose tmux/psmux, PATH, shell command, agent
  startup, and session state failures.
- Keep the logger usable from both VS Code extension code and CLI code.
- Keep `src/core` independent of the `vscode` module.
- Avoid logging full user prompts, task text, API keys, tokens, passwords, or
  complete environment dumps.
- Keep the performance cost negligible for create/start/attach flows.

## Non-Goals

- Do not replace `hydra worker logs` or `hydra copilot logs`; those remain pane
  capture commands for running sessions.
- Do not build a full telemetry or remote upload system.
- Do not upload logs automatically.
- Do not add a diagnostic bundle archive in V1. The file log and Output channel
  are enough for the first implementation.
- Do not log full terminal pane output or full agent transcripts.
- Do not make debug logging the default.

## User Experience

### Log File

Hydra writes a file log at:

```text
~/.hydra/logs/hydra.log
```

On Windows this resolves to:

```text
C:\Users\<user>\.hydra\logs\hydra.log
```

This path is stable across VS Code and CLI entry points because it is derived
from the same Hydra home resolution used for `sessions.json`, `archive.json`,
and `config.json`.

### VS Code Output

The extension creates an Output channel:

```text
Hydra
```

The channel shows user-actionable `info`, `warn`, and `error` messages. Debug
entries should stay file-only unless debug logging is enabled.

### Commands

Add these VS Code commands:

| Command | Purpose |
| --- | --- |
| `Hydra: Show Logs` | Reveal the `Hydra` Output channel. |
| `Hydra: Open Logs Folder` | Open `~/.hydra/logs` in the OS file browser. |
| `Hydra: Copy Diagnostic Info` | Copy a short diagnostic text block with Hydra version, platform, Hydra home, config path, log path, multiplexer command, and configured/default agent. |

### Error Actions

Startup errors should offer log-oriented actions. For example, copilot creation
should show:

```text
Failed to create copilot.
```

Actions:

```text
Show Logs
Open Logs Folder
Copy Details
```

The visible toast should stay concise. The detailed command, cwd, stderr,
stdout snippet, and stack belong in the log file.

### CLI Doctor

`hydra doctor` should include:

- Hydra home path.
- Hydra config path.
- Hydra log path.
- Whether the log directory exists and is writable.
- Resolved tmux/psmux availability.
- Resolved AI agent CLI availability.

## Log Format

Use JSON Lines. Each line is one event.

```json
{"ts":"2026-06-03T15:12:01.123Z","level":"error","scope":"tmux.createSession","message":"Failed to create multiplexer session","platform":"win32","pid":12345,"sessionName":"hydra-copilot-codex","agent":"codex","cwd":"C:\\Users\\Mr.Black","command":"psmux new-session -d -s ...","durationMs":318,"exitCode":1,"stderr":"...","stdout":"..."}
```

Required fields:

| Field | Description |
| --- | --- |
| `ts` | ISO timestamp. |
| `level` | `debug`, `info`, `warn`, or `error`. |
| `scope` | Stable code area such as `exec`, `tmux.createSession`, or `session.createCopilot`. |
| `message` | Human-readable summary. |
| `platform` | `process.platform`. |
| `pid` | Current process id. |

Common optional fields:

| Field | Description |
| --- | --- |
| `sessionName` | Hydra session name. |
| `agent` | Agent type or command category. |
| `cwd` | Working directory. |
| `command` | Redacted shell command. |
| `durationMs` | Operation duration. |
| `exitCode` | Child process exit code. |
| `stdout` | Redacted and truncated stdout snippet. |
| `stderr` | Redacted and truncated stderr snippet. |
| `error` | Redacted error message. |
| `stack` | Redacted stack trace for internal errors. |
| `promptLength` | Prompt/task length when relevant. |
| `promptHash` | Hash of prompt/task text when correlation is useful. |

## Retention and Rotation

Use size-based rotation because it is deterministic and avoids time-zone and
clock issues.

Default layout:

```text
~/.hydra/logs/
  hydra.log
  hydra.1.log
  hydra.2.log
  hydra.3.log
  hydra.4.log
```

Default limits:

- `hydra.log` maximum size: 5 MB.
- Retained rotated files: 4.
- Total default footprint: about 25 MB.

Rotation algorithm:

1. Before flushing a batch, check `hydra.log` size plus the pending batch size.
2. If the combined size is above the max, rotate.
3. Delete `hydra.4.log`.
4. Rename `hydra.3.log` to `hydra.4.log`.
5. Rename `hydra.2.log` to `hydra.3.log`.
6. Rename `hydra.1.log` to `hydra.2.log`.
7. Rename `hydra.log` to `hydra.1.log`.
8. Write the pending batch to a new `hydra.log`.

If a rename fails because a file does not exist, continue. If rotation fails
because of filesystem permissions, drop the pending file write and mirror a
single warning to any registered in-memory sinks. Logging must not crash Hydra.

## Configuration

Add VS Code configuration keys:

```json
{
  "hydra.logging.level": "info",
  "hydra.logging.maxFileSizeMB": 5,
  "hydra.logging.maxFiles": 5
}
```

Rules:

- `hydra.logging.level` applies to file logging.
- Output channel defaults to `info` and above.
- `debug` is opt-in.
- Invalid size/count values fall back to defaults.
- The CLI should use the same defaults. CLI-specific config can be added later
  if needed.

## Technical Architecture

Add shared core modules:

```text
src/core/logger.ts
src/core/logRedaction.ts
src/core/logRotation.ts
```

### `src/core/logger.ts`

Responsibilities:

- Define `LogLevel`, `LogEntry`, `LogContext`, and `LogSink`.
- Export a singleton-style `logger`.
- Support `debug`, `info`, `warn`, and `error`.
- Queue log entries in memory and flush asynchronously.
- Write JSONL to the rotating file sink.
- Allow additional sinks for VS Code Output.
- Expose helpers for log paths:
  - `getHydraLogsDir()`
  - `getHydraLogFilePath()`
- Expose `flush()` for tests and process shutdown.

Core should not import `vscode`.

Suggested API:

```ts
logger.info('session.createCopilot', 'Creating copilot session', {
  sessionName,
  agent,
  cwd,
});

logger.error('tmux.createSession', 'Failed to create multiplexer session', {
  sessionName,
  cwd,
  error,
});
```

### `src/core/logRedaction.ts`

Responsibilities:

- Redact secret-like key/value material.
- Truncate large strings.
- Normalize unknown errors into safe structured fields.

Default redaction patterns:

- `*_TOKEN`
- `*_SECRET`
- `*_PASSWORD`
- `*_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GITHUB_TOKEN`
- `Authorization: Bearer ...`
- `sk-...` style API keys when they appear in command text.

Default truncation:

- `stdout`: 8 KB.
- `stderr`: 8 KB.
- `stack`: 8 KB.
- `command`: 16 KB.
- Any generic string field: 16 KB.

### `src/core/logRotation.ts`

Responsibilities:

- Ensure `~/.hydra/logs` exists.
- Check file size.
- Rotate `hydra.log` through numbered backups.
- Keep rotation side effects isolated from logging API code.

### VS Code Wiring

In `src/extension.ts`:

- Create `vscode.window.createOutputChannel('Hydra')`.
- Register an Output sink with the core logger.
- Register `Hydra: Show Logs`, `Hydra: Open Logs Folder`, and
  `Hydra: Copy Diagnostic Info`.
- On activation, log:
  - extension version
  - platform
  - Hydra home
  - config path
  - log path
  - workspace folder count

Update error handling in command files to log the full failure before showing a
short toast:

- `src/commands/createCopilot.ts`
- `src/commands/newTask.ts`
- `src/commands/attachCreate.ts`
- `src/commands/removeTask.ts`
- `src/commands/ensureBackendInstalled.ts`

### CLI Wiring

In `src/cli/index.ts`:

- Initialize the file logger before registering commands.
- Log CLI startup at `debug`.
- On `beforeExit`, flush logger after telemetry.
- On `SIGINT`/`SIGTERM`, flush best-effort before exiting.

In `src/cli/output.ts`:

- Log structured CLI errors before printing stderr and exiting.

In `src/cli/commands/doctor.ts`:

- Add log path and log writability checks.
- Include log path in JSON output.

## Logging Points

### Shell Execution

`src/core/exec.ts` is the most important integration point because it is the
shared shell command boundary.

Log:

- `debug` before command execution:
  - scope: `exec.start`
  - command
  - cwd
- `debug` after successful command execution:
  - scope: `exec.success`
  - command
  - cwd
  - duration
  - stdout length
- `error` after failed command execution:
  - scope: `exec.failure`
  - command
  - cwd
  - duration
  - exit code
  - stdout/stderr snippets
  - error message

This would have captured the Windows `env -u ... psmux new-session ...`
failure that motivated issue #213.

### Multiplexer

In `src/core/tmux.ts`, log:

- `isInstalled`
- `listSessions`
- `createSession`
- `hasSession`
- `sendKeys`
- `capturePane`

Use operation-specific scopes such as `tmux.createSession`. Avoid logging the
contents of `sendKeys` when it may contain a prompt. Record only command type,
length, and hash when needed.

### Session Lifecycle

In `src/core/sessionManager.ts`, log:

- `createCopilot`
- `createWorker`
- `startWorker`
- `restore`
- `delete`
- `waitForReadyAndCaptureSessionId`
- `captureAgentSessionInfo`

Do not log full initial task text or onboarding prompt text. Log prompt length
and hash only.

## Privacy and Safety

Logging must be useful enough for support without becoming a transcript or
secret leak.

Rules:

- Never log full prompts or worker tasks.
- Never log full environment maps.
- Never log API keys or token-like values.
- Redact secrets inside commands, stdout, stderr, error messages, and stacks.
- Truncate large text fields before writing.
- Treat logger failures as non-fatal.

## Performance

The logger should not meaningfully affect session creation speed.

Implementation rules:

- Logging calls enqueue entries and return quickly.
- Flush asynchronously with a short debounce, e.g. 100 ms.
- Flush immediately only for process shutdown or tests.
- Batch writes with `appendFile`.
- Keep debug logging disabled by default.
- Bound each entry size before enqueueing.
- Rotation checks run only before file flush, not on every field mutation.

Expected default cost is a small number of file appends during user-triggered
operations. These paths are not high frequency.

## Testing Plan

Add focused smoke/unit-style tests:

- Redaction redacts token/password/API-key values in commands and stderr.
- Truncation caps stdout/stderr/stack fields.
- Rotation creates `hydra.1.log` and keeps only the configured count.
- `exec()` failure writes an `exec.failure` entry with command, cwd, exit code,
  stderr, and redacted content.
- Logger failures do not throw into callers.

Add a real CLI/e2e check:

- Run Hydra with isolated `HYDRA_HOME`.
- Force a session creation failure by setting an isolated command environment
  where the multiplexer command cannot run, or by using an invalid
  `HYDRA_TMUX_SOCKET`/backend setup that makes the create path fail.
- Assert `~/.hydra/logs/hydra.log` exists.
- Assert the log includes the failed command scope and error context.

## V1 Acceptance Criteria

- Failed copilot or worker creation creates `~/.hydra/logs/hydra.log`.
- Logs include Hydra version or entry-point version, platform, cwd,
  sessionName, agent, command scope, stderr/stdout snippet, and error message
  when available.
- VS Code `Output -> Hydra` shows high-level `info`, `warn`, and `error`
  entries.
- `hydra doctor` prints the log path and checks log directory writability.
- Full user prompts and secret-like values are absent from the log.
- Compile, lint, focused logger tests, and a real CLI/e2e logging check pass.

## Open Questions

- Should `Copy Diagnostic Info` include the last N error entries in a future
  release? V1 should not include log excerpts automatically.
- Should debug logging be configurable from CLI config as well as VS Code
  settings? V1 can keep CLI defaults fixed.
- Should diagnostic bundles include `sessions.json` with redaction? This is
  useful but should be a separate product decision.
