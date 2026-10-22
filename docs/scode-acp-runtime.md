# Structured scode ACP runtime

Hydra can own a complete `scode acp` process through the official ACP SDK. This
is an optional runtime alongside the existing tmux worker workflow. It exposes
native session IDs, prompt results, unsolicited notifications, permissions and
questions without manufacturing terminal panes.

The first integration provides the long-lived `HydraAppService` API and an
explicit foreground CLI connector. Existing `worker create`, terminal attach,
pane management and tmux worker discovery retain their existing behavior.
Structured runtimes have their own list and status operations; they are not
silently inserted into tmux's session reconciliation.

## Connection core

`@hydra/core/scodeAcp` exports `connectScode(config, onNotification)`. Its
implementation lives in `packages/core/src/core/scodeAcp.ts`. Hydra's runtime
registry and external controller bridges use that same module.

The official SDK owns NDJSON framing, request correlation and permanent
`session/update` dispatch. Hydra uses stable ACP v1 with SDK 1.9.0; see the
[official SDK connection API](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/acp.ts).
The adapter is bundled as CommonJS so Hydra's CommonJS applications and ESM
controller bridges can load the same implementation. `npm run compile` creates
the bundle; building only `@hydra/core` also creates it.

```js
// CommonJS host
const { connectScode } = require('@hydra/core/scodeAcp');

// ESM controller using a deployed copy of that exact build
import core from './hydra-acp/scodeAcp.cjs';
const { connectScode } = core;
```

No machine address, account, model, Nexus credential, controller thread ID or
workspace is embedded in the core. Optional protocol/stderr logs belong to the
caller and may contain private session data; protect their destination.

## Foreground connector

Create a private JSON launch configuration, for example:

```json
{
  "scodeArgv": ["scode", "acp"],
  "workspace": "/absolute/project",
  "acpSessionId": "existing-native-session-id"
}
```

Use an absolute workspace on either platform. Pin the executable with an
absolute path when provenance matters. `scodeArgv` is an argument array passed
directly to `spawn`, with no shell interpretation. Omit `acpSessionId` only when
you intend to create a new native session. A supplied session must load; an
unsupported or failed load never falls back to a fresh session.

```sh
hydra agent-runtime connect --config /absolute/runtime.json
```

The command remains the process owner while stdin stays open, including after
a prompt has finished. Stdout emits newline JSON records: `ready`, `event`,
`result` or `error`. Commands on stdin use a distinct caller request ID:

```json
{"id":"p1","op":"prompt","text":"Inspect the current changes"}
{"id":"s1","op":"status"}
{"id":"c1","op":"cancel"}
{"id":"x1","op":"stop"}
```

`cancel` requests cancellation; completion is observed in subsequent runtime
events/results. `stop`, stdin EOF and CLI shutdown explicitly close the child
owned by this foreground command. `--once "text"` performs one prompt and
stops, so it does not provide later idle notifications.
`--once` rejects manual input flags; use the persistent connector when answers
must arrive on stdin, including during session loading.

Permissions default to cancellation. To handle them yourself, select
`--manual-permissions`; respond to the emitted permission request with an
offered option ID, or `null` to cancel:

```json
{"id":"a1","op":"permission","requestId":"request-id-from-event","optionId":"offered-option-id"}
```

For scode's native `_scode/ask_user_question` requests, select
`--manual-questions` and answer the emitted fields explicitly:

```json
{"id":"a2","op":"question","requestId":"request-id-from-event","answers":[{"id":"action","value":"chosen-offered-value"}]}
```

Unknown, duplicate or missing required fields and non-offered single-select
choices are rejected. Other native question kinds keep scode's string values;
the adapter invents no multi-select array or boolean encoding. A missing question
handler returns an explicit error. No peer message
or plan text is treated as a human approval. These options do not change the
outer controller's approval policy.

## Long-lived service API

`HydraAppService` owns an `AgentRuntimeRegistry`. Its optional agent-runtime
operations connect, list, inspect, prompt, cancel, stop and answer input
requests. `HydraClient` exposes the corresponding typed methods, including
`subscribeAgentRuntimeEvents`.

Closing an event subscription detaches that observer and leaves the runtime
alive. Explicit stop closes the owned ACP process. Disposing the service stops
its owned runtimes, including pending initialization; no background supervisor
or startup service is installed.

Foreground prompts are serialized within a runtime. ACP notifications remain
connection events: a native A2A turn can overlap a Hydra foreground prompt, so
assistant chunks are not presented as correlated prompt output. Event replay
is bounded, with sequence numbers; it is not a durable mailbox or an
exactly-once notification guarantee.

Sequence numbers belong to one runtime instance. After explicit stop and
reconnect, fetch a fresh snapshot rather than reusing the previous instance's
event cursor. The registry refuses a second owned connection for the same
canonical workspace before spawning another CLI.

The full scode CLI owns its existing Nexus discovery, identity and receiver.
Hydra adds no second mailbox watcher for these runtimes and never mints an
identity as a side effect. Prepare any required existing agent credential using
the node owner's established procedure. Connecting fails according to scode's
native attach rules when a credential is missing.

## Direct A2A and controller MCP

Explicit messages do not need an inner model turn. The shared
`@hydra/core/scodeA2a` module exports `sendScodeMessage(connection, input)` and
`listScodeAgents(connection, options)`. Both use the existing connection and its
loaded native session. They require initialize metadata
`_meta.sudocode.directA2a = {"version":1}` and call the paired ACP extensions
`_sudocode/a2a/send` and `_sudocode/a2a/agent_list`. An older scode produces an
explicit compatibility error; the bridge never falls back to `session/prompt`.

The send request carries only `sessionId`, `to`, a plain text `message` and an
optional `summary`. The host binds the actor and namespace. No sender override,
credential, arbitrary tool name or structured agent-control object is accepted.
The scode implementation must reuse its engine command seam, tool scheduler,
hooks, permissions, allowed tools and actual mailbox. Pause and active-turn
refusals occur before execution; a busy send is not queued behind a model turn.

A result is the real tool output as `{content:string,isError:boolean}`. The MCP
entry wraps that unchanged string in one text content block; the shared ACP
helper returns the native result directly.
Queue admission is not success. Preserve its text, including append/routing
details and uncertain outcomes. After submission, a lost response, disconnect,
timeout or malformed result is **Unknown**: do not automatically retry or send
the same instruction through a model. `isError` alone does not prove an append
did not happen. The bridge has no exactly-once or delivery guarantee.

Controllers can use the packaged MCP entry instead of a machine-specific MCP
script:

```sh
hydra agent-runtime mcp --config /absolute/scode-mcp.json
```

```json
{
  "version": 1,
  "scodeArgv": ["/absolute/pinned/scode", "acp"],
  "workspace": "/absolute/project",
  "acpSessionId": "existing-native-session-id",
  "auditLog": "/absolute/private/scode-external-commands.jsonl"
}
```

Prepare the existing native session once, using the normal scode CLI or the
foreground connector, then record the real ID. Each controller owns its own
stable scode actor and session. Close its previous owner before reconnecting;
do not configure multiple controllers to load the same session. The MCP bridge
does not create agents, mint credentials, start Nexus or alter `node.json`.

For Codex, a project-scoped `.codex/config.toml` entry uses the ordinary
[MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
Replace the paths with those on that machine:

```toml
[mcp_servers.nexus_scode]
command = "/absolute/hydra"
args = ["agent-runtime", "mcp", "--config", "/absolute/scode-mcp.json"]
required = false
tool_timeout_sec = 90
```

This exposes `scode_prompt` for tasks, `scode_send` for exact text,
`scode_agent_list` for directory queries and `scode_status` for bridge ownership
and capability. An installed bridge with an old scode still supports prompts;
direct tools return an explicit unsupported error. Install both compatible
versions before relying on direct tools, then reconnect/restart the original
controller. No Nexus upgrade is needed for this ACP extension.
If the owned scode exits, MCP stays available to report `closed:true` and return
in-flight errors. It does not respawn the agent or discard an Unknown result;
reconnection remains an explicit owner action.

Permissions requiring a client decision are cancelled by this MCP entry; it
does not auto-approve or change the outer controller's approval policy. Use the
foreground connector's manual permission flow when interactive approval is
needed. The external command audit records caller request IDs, native session,
PID, input/output hashes and outcome separately from model history. It creates
no synthetic model tool calls. Direct sends do not enter the inner model's
context; a later peer reply may therefore lack conversational context there.

Prompt results include a bounded `observedNotifications` collection without
reasoning chunks. These are connection observations during the request, not a
correlated final answer: native background activity can overlap a prompt.

### Optional callback to an existing Codex thread

MCP tool discovery alone does not wake an idle controller. For a native Codex
app-server frontend which already has the original thread loaded, add:

```json
"codexCallback": {
  "codexArgv": ["/absolute/codex"],
  "socket": "/absolute/native-server.sock",
  "threadId": "original-codex-thread-id",
  "peers": ["approved-peer-name"],
  "log": "/absolute/private/scode-callbacks.jsonl"
}
```

The adapter connects through `codex app-server proxy`, forwards only matching
native-session A2A messages from the configured peers, and uses `turn/start`
when idle or `turn/steer` with the current turn ID when active. It never resumes
or forks a thread, launches a second native server, or changes approval settings.
An inherited `CODEX_THREAD_ID` must match the configured target. A callback
failure stays pending in its log; ambiguous requests are not replayed. This
experimental native [app-server API](https://learn.chatgpt.com/docs/app-server)
must be checked against the installed Codex version.
Protect config, audit, protocol and callback logs as private local files.

The callback option assumes an existing app-server frontend. It is not a
launcher or an npm patch, and a plain MCP configuration does not convert a
different frontend into that mode. New-machine frontend provisioning and Nexus
service enrollment are separate steps.

## Validation

```sh
npm run compile
npm run lint
npm run smoke:scode-acp
npm run smoke:agent-runtime
npm run smoke:agent-runtime-service
npm run smoke:agent-runtime-cli
npm run smoke:scode-mcp
```

The ACP smoke uses a real official-SDK stdio peer for native loading, idle
notifications, permissions, questions, initialization failure and bounded stop.
Registry/service tests cover ownership, subscription detach, input routing and
the tmux/Nexus boundary. Real controller bridge adoption and cross-host wakeup
receipts are deployment evidence, separate from these protocol fixtures.
The MCP smoke runs an actual MCP client/server and ACP SDK stdio fixture,
including response loss, strict inputs and absence of prompt fallback. It does
not substitute for sudocode's real-engine, zero-inference and authorized Nexus
append tests or a native Codex callback deployment receipt.
