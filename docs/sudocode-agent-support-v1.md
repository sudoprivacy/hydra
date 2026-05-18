# Sudo Code Agent Support v1

Status: v1 implementation plan for issue #162.

This document describes the first production-ready integration of Sudo Code
(`scode`) into Hydra's existing tmux-based agent model. It intentionally uses
Sudo Code's ordinary interactive REPL mode, not ACP, so the change fits the
current Claude/Codex/Gemini architecture.

## Background

Hydra currently treats agents as long-lived terminal processes inside tmux. A
worker or copilot is launched, Hydra waits for the agent's idle prompt, captures
the agent session identifier, and then sends prompts into the terminal.

Sudo Code fits this model when launched as plain `scode`:

- `scode` with no prompt starts an interactive REPL.
- The idle prompt is `❯`.
- The startup banner prints both:
  - `Session          session-<millis>-<counter>`
  - `Auto-save        .scode/sessions/<workspace-hash>/<session-id>.jsonl`
- Session files are stored under the current worktree:
  - `<worktree>/.scode/sessions/<workspace-hash>/<session-id>.jsonl`
- `/resume <session-ref>` inside the REPL switches the live REPL to an existing
  session.

The main incompatibility is resume. `scode --resume <id>` is not a long-lived
terminal resume command. It restores the session, prints information or runs
resume-supported slash commands, and exits. Hydra must therefore resume Sudo
Code by starting a fresh REPL and then sending `/resume <session-ref>` into it.

## Goals

- Add `sudocode` as a first-class Hydra agent type.
- Launch Sudo Code in ordinary interactive REPL mode.
- Capture Sudo Code session ids and session files.
- Support fresh copilot and worker creation.
- Support `stop` / `start` for stopped workers.
- Support archive restore for deleted workers when the restored worktree path is
  the same as the original path.
- Keep model, auth, and proxy behavior owned by the user's local Sudo Code
  configuration.
- Avoid changing Hydra's tmux backend or introducing ACP in v1.

## Non-Goals

- No ACP transport integration.
- No one-shot `scode "prompt"` or `scode --print` integration.
- No hard-coded Sudo Code model, auth mode, endpoint, proxy, or token behavior.
- No automatic worker-completion notification for Sudo Code in v1.
- No cross-machine or arbitrary-cross-path Sudo Code session migration.
- No changes to Sudo Code itself.

## Prior PR Assessment

PR #139 has useful low-risk scaffolding:

- `sudocode` agent type.
- Default command `scode`.
- Auto-approve flag `--dangerously-skip-permissions`.
- Ready pattern `❯`.
- Basic session capture from `Session session-...`.
- VS Code command and setting contributions.
- CLI help and doctor updates.

It should not be applied directly because:

- It uses `scode --resume <session-id>` as a long-lived resume command, which is
  incompatible with Sudo Code's actual behavior.
- It adds `.sudocode/skills`, which Sudo Code does not currently scan. Sudo Code
  scans `.nexus/sudocode/skills`, `.agents/skills`, `.codex/skills`, and
  `.claude/skills`, so Hydra's existing `.codex/skills` and `.claude/skills`
  links already give it skill visibility.
- It does not preserve `.scode/sessions` before deleting worker worktrees.
- It does not account for Sudo Code's lack of a turn-completion hook.
- It was built against an older Hydra main and misses later Codex/session/share
  changes.

## Agent Configuration

Add `sudocode` everywhere Hydra enumerates built-in agents:

- `src/core/types.ts`
  - `AgentType = 'claude' | 'codex' | 'gemini' | 'sudocode' | 'custom'`
- `src/core/agentConfig.ts`
  - `AGENT_LABELS.sudocode = 'Sudo Code'`
  - `DEFAULT_AGENT_COMMANDS.sudocode = 'scode'`
  - `AGENT_YOLO_FLAGS.sudocode = '--dangerously-skip-permissions'`
  - `AGENT_READY_PATTERNS.sudocode = /❯/`
  - `AGENT_SESSION_CAPTURE.sudocode = { statusCommand: '/status', ... }`
- VS Code extension activation and `package.json`
  - Start Copilot command.
  - Explicit `onCommand:*` activation events for contributed Hydra commands.
  - `hydra.sudocodeAvailable` context key.
  - `hydra.defaultAgent` enum.
  - `hydra.agentCommands` default.
- Hydra global config
  - VS Code syncs `hydra.agentCommands` into `HYDRA_CONFIG_PATH`.
  - CLI-created workers use the same configured agent command as the
    extension-created copilot.
- CLI help text for worker/copilot creation.
- Doctor agent discovery.
- Telemetry allowlist.

The default launch command must remain `scode` plus Hydra's permission flag.
Hydra must not bake in `--model`, `--auth`, proxy env vars, or user-specific
credentials. Users who need a proxy can configure it through their shell or
through `hydra.agentCommands.sudocode`, for example:

```json
{
  "sudocode": "env HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1,::1 scode"
}
```

## Launch Semantics

Hydra should always launch Sudo Code as a persistent REPL:

```text
scode --dangerously-skip-permissions
```

Initial worker tasks are sent after readiness and session capture via
`backend.sendMessage()`. Hydra must not pass a worker task as argv to `scode`,
because `scode "task"` is one-shot and exits.

Implementation detail:

- Existing `buildAgentLaunchCommand()` can keep supporting current agents.
- Either add a persistent launch helper or ensure Sudo Code call sites never pass
  a `task` argument into `buildAgentLaunchCommand()`.
- Add a smoke test that fails if the Sudo Code worker creation flow launches
  `scode '<task>'`.

## Resume Strategy

Replace the single-command resume assumption with an explicit strategy.

Suggested shape:

```ts
type AgentResumeStrategy =
  | {
      kind: 'command';
      command: string;
    }
  | {
      kind: 'replSlashCommand';
      launchCommand: string;
      slashCommand: string;
    };
```

Agent behavior:

| Agent | Resume strategy |
| --- | --- |
| Claude | `command`: `claude --resume <id>` |
| Codex | `command`: `codex ... resume -C <workdir> <id>` |
| Gemini | `command`: `gemini --resume <id>` |
| Sudo Code | `replSlashCommand`: launch `scode ...`, wait ready, send `/resume <ref>`, wait for resume completion and the next prompt |

The Sudo Code resume sequence:

1. Create the tmux session.
2. Send `scode --dangerously-skip-permissions`.
3. Wait for `❯`.
4. Send `/resume <session-ref>`.
5. Wait for a new `Session resumed` report and then a following `❯`.
6. For worker restore with a task, send the task only after the second ready
   wait.

Never use `scode --resume <id>` for a long-lived Hydra session.
Sudo Code parses `/resume` by taking the full remainder after the command name,
so file paths with spaces should be sent raw rather than shell-quoted.

## Session Capture

Hydra should capture two values for Sudo Code:

- `sessionId`: `session-<millis>-<counter>`
- `agentSessionFile`: absolute path to the `.jsonl` session file, when known

The existing `sessionId` field remains the public identifier. Add a new optional
field instead of overloading `sessionId`:

```ts
interface WorkerInfo {
  sessionId: string | null;
  agentSessionFile?: string | null;
}

interface CopilotInfo {
  sessionId: string | null;
  agentSessionFile?: string | null;
}

interface ArchivedSessionInfo {
  agentSessionId: string | null;
  agentSessionFile?: string | null;
}
```

Capture algorithm:

1. Wait for `❯`.
2. Capture existing pane output.
3. Try to parse the startup banner:
   - `Session          session-1778832876869-0`
   - `Auto-save        .scode/sessions/.../session-1778832876869-0.jsonl`
4. If the banner was missed, send `/status` and parse the session from the
   `Session` path line.
5. Resolve relative `Auto-save` paths against the worker/copilot workdir.
6. Persist `sessionId` and `agentSessionFile`.

Suggested parser behavior:

```ts
const sessionIdPattern = /\b(session-\d+-\d+)\b/;
const autoSavePattern = /Auto-save\s+(.+?\.jsonl)\b/;
const statusSessionPathPattern = /Session\s+(.+?session-\d+-\d+\.jsonl)\b/;
```

For non-Sudo agents, keep the existing id-only capture behavior.

## Session File Resolution

Extend `resolveAgentSessionFile(agent, workdir, sessionId)`:

- For `sudocode`, scan:
  - `<workdir>/.scode/sessions/*/<sessionId>.jsonl`
- Return `null` when the workdir or session file is missing.

Prefer the persisted `agentSessionFile` when present and still exists. Fall back
to resolver scanning by id.

## Archive and Restore

Sudo Code stores sessions inside the worker worktree. `deleteWorker()` removes
the worktree, so the session file would otherwise be lost.

Before removing a Sudo Code worker worktree:

1. Resolve the current session file from `worker.agentSessionFile` or
   `resolveAgentSessionFile('sudocode', worker.workdir, worker.sessionId)`.
2. Copy it into Hydra-owned storage:

   ```text
   ~/.hydra/agent-sessions/sudocode/<session-name>/<session-id>.jsonl
   ```

3. Store the copied path on the archive entry as `agentSessionFile`.
4. Continue with worktree and branch cleanup.

Restore behavior:

- Use `entry.agentSessionFile` as the preferred Sudo Code session ref.
- Fall back to `entry.agentSessionId` if there is no copied file.
- Launch REPL and send `/resume <ref>`.

Important limitation:

Sudo Code validates the session's `workspace_root`. Archive restore is expected
to work when Hydra recreates the worker at the same deterministic worktree path.
If the repo or worktree path changes, Sudo Code may reject the restored session.
That is acceptable for v1.

## Completion Notification

Hydra's parent-copilot notification currently depends on agent lifecycle hooks:

- Claude: `Stop`
- Codex: `Stop`
- Gemini: `AfterAgent`

Sudo Code currently supports only tool-level hooks:

- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`

These hooks are not equivalent to "the agent completed the user's task". Using
`PostToolUse` would notify too early and may notify multiple times.

Add a capability check:

```ts
function supportsCompletionNotification(agentType: string): boolean {
  return agentType === 'claude' || agentType === 'codex' || agentType === 'gemini';
}
```

For Sudo Code:

- Do not inject hook config.
- Do not arm the pending notification file.
- Worker creation should still succeed when
  `hydra.notifyCopilotOnWorkerComplete` is enabled.

If Sudo Code later adds a turn/session completion hook, support can be added
without changing worker launch or resume semantics.

## CLI and VS Code Behavior

User-visible additions:

- `hydra worker create --agent sudocode ...`
- `hydra copilot create --agent sudocode ...`
- VS Code welcome action: `Hydra: Start Copilot (Sudo Code)`
- `hydra doctor` recognizes `scode`
- `hydra list --json` and logs commands include `agent: "sudocode"`
- `sessionFile` output resolves to the Sudo Code `.jsonl` file when available
- A copilot launched from the VS Code extension and a worker launched by that
  copilot through the `hydra` CLI use the same `hydra.agentCommands.sudocode`
  value.

No user-facing command should imply ACP support in v1.

## Implementation Plan

1. Add agent enum/config/UI/CLI scaffolding.
2. Add Sudo Code launch and capture config.
3. Refactor resume from `buildAgentResumeCommand()` into a resume strategy.
4. Update worker and copilot lifecycle flows to handle `replSlashCommand`.
5. Capture and persist `agentSessionFile`.
6. Add Sudo Code support to `resolveAgentSessionFile()`.
7. Copy Sudo Code session files during worker archive.
8. Use copied archive session files during restore.
9. Gate completion notification by agent capability.
10. Sync VS Code agent command settings to Hydra global config for nested CLI
    worker creation.
11. Add command activation events so command-palette entrypoints activate the
    extension without requiring the Hydra view to open first.
12. Add smoke tests.
13. Update README/AGENTS references to list Sudo Code as supported.

## Test Plan

### Static Validation

Run before opening a PR:

```bash
npm run compile
npm run lint
```

Run before marking the PR ready:

```bash
npm test
```

### Unit and Smoke Tests

Add or extend smoke tests for the following cases.

#### Agent Config

- `DEFAULT_AGENT_COMMANDS.sudocode` is `scode`.
- Sudo Code launch includes `--dangerously-skip-permissions`.
- Sudo Code ready pattern matches `❯`.
- Sudo Code capture regex parses:
  - startup banner `Session          session-...`
  - startup banner `Auto-save        .scode/sessions/...jsonl`
  - status output path `Session          .../session-...jsonl`
- Sudo Code resume strategy is `replSlashCommand`.
- No helper returns `scode --resume <id>` for Sudo Code.

#### Session File Resolution

Fixture:

```text
<tmp-workdir>/.scode/sessions/abc123/session-1000-0.jsonl
```

Assertions:

- `resolveAgentSessionFile('sudocode', workdir, 'session-1000-0')` returns the
  fixture path.
- Missing session id returns `null`.
- Missing workdir returns `null`.
- Unknown agent behavior remains unchanged.

#### Fresh Worker Create

Use a fake `scode` script in a temp directory. The fake script should:

- Print a Sudo Code-like banner with session id and auto-save path.
- Print `❯`.
- Record stdin lines to a file.
- When it receives a normal task prompt, print a response and `❯`.

Assertions:

- Hydra sends the persistent launch command, not `scode '<task>'`.
- Hydra captures `sessionId`.
- Hydra captures `agentSessionFile`.
- Hydra sends the worker task after capture.
- `sessions.json` records `agent: "sudocode"`.

#### Stop and Start Worker

Using the same fake agent:

- Create a worker.
- Stop it.
- Start it again.

Assertions:

- Restart launches `scode ...`.
- Restart then sends `/resume <session-ref>`.
- Restart waits for the new resume report and prompt after `/resume`, not any
  stale prompt already present in the pane.
- It does not send `scode --resume`.

#### Archive Restore

Using a fake session file:

- Create a Sudo Code worker.
- Ensure its session file exists.
- Delete the worker.
- Restore from archive.

Assertions:

- Delete copies the session file under
  `~/.hydra/agent-sessions/sudocode/<session-name>/`.
- Archive entry includes `agentSessionFile`.
- Restore sends `/resume <copied-session-file>`.
- Restore recreates the worker using agent `sudocode`.

#### Completion Notification Gating

With `notifyCopilotOnWorkerComplete` enabled:

- Create a Sudo Code worker with a parent copilot.

Assertions:

- No Sudo Code hook config is written.
- No pending notification file is armed for Sudo Code.
- Worker creation still succeeds.
- Existing Claude/Codex/Gemini hook tests continue to pass.

#### CLI JSON Fields

Seed a Sudo Code worker in `sessions.json` and create a fixture session file.

Assertions:

- `hydra list --json` returns `agentSessionId` and `sessionId`.
- `hydra list --json` resolves `sessionFile`.
- `hydra worker logs --json` includes the same session fields.

### Manual Tests

Run these with a real locally configured `scode`.

#### Fresh Copilot

```bash
hydra copilot create --agent sudocode --workdir /Users/hanlu/Desktop/ai/hydra --name sudocode-smoke
hydra copilot logs sudocode-smoke --lines 80
```

Expected:

- Sudo Code banner appears.
- Model/auth/proxy reflect the user's local `scode` configuration.
- Hydra captures session id.
- `hydra list --json` shows the copilot as running with agent `sudocode`.

#### Extension-Created Copilot And Worker

Use the `/test-hydra` skill to launch an Extension Development Host.

Expected:

- `Hydra: Start Copilot (Sudo Code)` activates the extension from the command
  palette.
- Sudo Code launches as a copilot and auto-confirms its broad-directory prompt.
- `HYDRA_CONFIG_PATH` contains synced `agentCommands.sudocode`.
- A prompt to the copilot that runs `hydra worker create --agent sudocode`
  creates a worker whose pane also launches through the configured command.
- The worker can answer, stop/start, resume through `/resume <jsonl>`, answer
  again, and archive its copied Sudo Code session file on delete.

#### Fresh Worker

```bash
hydra worker create \
  --repo /Users/hanlu/Desktop/ai/hydra \
  --branch test/sudocode-v1-smoke \
  --agent sudocode \
  --task "Inspect package.json and reply with one sentence. Do not edit files."
```

Expected:

- Worker starts in a new worktree.
- Prompt is delivered after Sudo Code reaches `❯`.
- Agent responds.
- `hydra worker logs <session> --json` includes session id and session file.

#### Stop and Start

```bash
hydra worker stop <session>
hydra worker start <session>
hydra worker send <session> "Reply with the active session id from /status."
```

Expected:

- The restarted process is a fresh `scode` REPL.
- Hydra sends `/resume ...` inside the REPL.
- Conversation context is preserved.

#### Delete and Restore

```bash
hydra worker delete <session>
hydra archive restore <session>
hydra worker send <session> "Confirm whether this is the restored Sudo Code session."
```

Expected:

- The archive entry has a copied Sudo Code session file.
- Restore uses `/resume <copied-jsonl>`.
- The restored worker responds with prior context when the worktree path is
  recreated at the same location.

#### Notification Behavior

Create a Sudo Code worker from a copilot while
`hydra.notifyCopilotOnWorkerComplete` is true.

Expected:

- No automatic completion notification is sent.
- No error is shown.
- Worker logs and review flow still work.

## Acceptance Criteria

The v1 implementation is complete when:

- Sudo Code appears in VS Code and CLI agent choices.
- `hydra worker create --agent sudocode` starts a real long-lived Sudo Code
  REPL.
- Hydra captures Sudo Code session id and session file.
- `hydra worker stop/start` resumes by sending `/resume` inside a new REPL.
- `hydra worker delete` preserves the Sudo Code session file before worktree
  removal.
- `hydra archive restore` resumes from the copied Sudo Code session file when
  the worktree path is unchanged.
- Completion notifications are explicitly skipped for Sudo Code without
  breaking worker creation.
- Compile, lint, smoke tests, and real local manual tests pass.

## Known Risks

- If a user's proxy is only defined as an interactive shell function, Hydra
  cannot resolve that function as an executable. The user should set
  `hydra.agentCommands.sudocode` to an explicit command such as
  `env HTTPS_PROXY=... scode`.
- Sudo Code may reject restored sessions when the restored worktree path differs
  from the original `workspace_root`.
- Session file copying preserves the last persisted Sudo Code state. If Sudo
  Code is killed mid-turn before persisting, the latest partial output may be
  absent.
- The one-shot Sudo Code path can have different config behavior from REPL mode;
  Hydra v1 must not depend on one-shot mode.
