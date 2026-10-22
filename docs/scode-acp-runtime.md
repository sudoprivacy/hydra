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

## Validation

```sh
npm run compile
npm run lint
npm run smoke:scode-acp
npm run smoke:agent-runtime
npm run smoke:agent-runtime-service
npm run smoke:agent-runtime-cli
```

The ACP smoke uses a real official-SDK stdio peer for native loading, idle
notifications, permissions, questions, initialization failure and bounded stop.
Registry/service tests cover ownership, subscription detach, input routing and
the tmux/Nexus boundary. Real controller bridge adoption and cross-host wakeup
receipts are deployment evidence, separate from these protocol fixtures.
