# Hydra desktop app proposal: Fork A now, B-compatible interfaces

This proposal is based on the current repo shape: `src/core/sessionManager.ts`,
`src/core/tmux.ts`, `src/core/events.ts`, `src/core/notificationStateService.ts`,
`src/core/workerRuntimeStateService.ts`, the CLI commands under `src/cli/commands`,
the VS Code diff command in `src/commands/reviewChanges.ts`, and the terminal bridge
spike in `spikes/terminal-bridge/FINDINGS.md`.

### 1. 产品形态 (Product form)

**Position: build a standalone Electron app with a spawned Node sidecar.** The app is
not "VS Code without the editor"; it is a mission-control surface for parallel agents
whose durable runtime is still tmux plus Hydra's local state. Electron is the correct
v1 shell because Hydra's engine is already TypeScript/Node (`src/core` and `src/cli`
have no `vscode` imports), the terminal bridge needs `node-pty`, and Electron keeps
native-module packaging, tray behavior, auto-update, deep links, and renderer-to-Node
IPC in one JavaScript toolchain. Tauri's footprint is attractive, but it would force
Hydra to either ship a Node sidecar anyway or port the engine to Rust; that gives up
the main advantage of the existing codebase while making `node-pty` packaging harder.

Primary surfaces:

- **Mission Control:** a dense grid grouped by repo and Local Tasks, showing worker
  number, branch/task name, agent, lifecycle (`running`/`stopped`), runtime projection
  (`unknown`/`running`/`idle`/`needs-input`/`error` from
  `worker-runtime-state.json`), unread notification count, dirty diff count, and last
  event time. This replaces the VS Code tree provider as the primary screen.
- **Per-worker terminal:** xterm.js backed by a sidecar WebSocket that attaches to the
  worker's tmux session. One interactive viewer owns size; secondary views are
  read-only mirrors. The terminal layer follows the spike: `node-pty` runs
  `tmux attach`, tmux owns state, reconnect repaints the current screen.
- **Diff review:** a headless version of `src/commands/reviewChanges.ts`: compute
  base ref from `branch.<name>.vscode-merge-base`, then `origin/main`, `main`,
  `origin/master`, `master`; collect `git diff --name-status --find-renames` plus
  untracked files; render file list, side-by-side diff, and commit/push/PR actions.
- **Copilot view:** a top-level control center for copilots, not a repo-scoped view.
  It shows each copilot terminal, managed workers, outstanding messages, and quick
  actions to create/send/broadcast/restore.
- **Notifications:** an inbox and per-session badges driven by `notifications.json`
  and `events.jsonl`: complete, needs-input, error, blocked, info. Opening a
  notification focuses the relevant terminal, diff, or copilot message.

Coexistence:

- **CLI stays first-class.** `docs/cli-contract.md` is already a compatibility
  contract; desktop v1 must not replace it. The sidecar should import the same core
  classes instead of shelling out to `hydra`, but its public verbs should mirror CLI
  JSON fields so scripts, copilots, and the desktop speak the same domain language.
- **VS Code extension stays.** It remains the editor-native surface and can continue
  sharing `~/.hydra/*.json`, tmux sessions, and `events.jsonl`. Later it should become
  another client of the same `HydraControlClient`, but not before desktop v1 ships.
- **Local state remains shared.** A worker created in the CLI appears in desktop, and
  a worker created in desktop appears in `hydra list --json`, because `SessionManager`
  still persists sessions under `HYDRA_HOME`.

Key v1 flow:

1. User opens Mission Control; sidecar runs `SessionManager.sync()` and subscribes to
   events.
2. User creates a code worker with repo, branch, agent, optional base, and task prompt;
   sidecar calls `createWorker`/`createDirectoryWorker` directly and streams the
   `worker.created` / `worker.started` events into the UI.
3. User monitors runtime state and notifications; `worker.runtime.changed` and
   `notify.created` update the board without renderer polling.
4. User opens the terminal; renderer connects to a terminal WebSocket for that tmux
   session, sends input/resize, and receives raw PTY output.
5. User reviews the diff; desktop shows the changed-file list, inline/side-by-side
   diff, and a push/PR handoff.
6. User ships or deletes/stops the worker; sidecar calls the same engine methods the
   CLI already uses.

MVP scope:

- In: local-only Electron app, Node sidecar, mission-control board, create/start/stop/
  delete/rename worker and copilot actions, terminal attach, logs capture, send/broadcast,
  notifications, diff review, settings for default agent and agent commands, basic tray
  badge for unread/needs-input.
- Out: long-running daemon, remote access, account system, multi-device web dashboard,
  independent multi-client terminal sizing, per-pane UI surfaces, encrypted share bundle
  UX, built-in PR creation beyond a `gh`/browser handoff, Windows desktop support unless
  tmux/runtime support is productized separately.

### 2. 技术方案 (Technical plan)

Fork A architecture:

```text
+---------------- Electron main process ----------------+
| app lifecycle, tray, update, localhost token, IPC       |
|                                                        |
|  spawn/monitor                                         |
|       v                                                |
|  +---------------- Node sidecar -------------------+   |
|  | HydraAppService                                  |   |
|  | - SessionManager + TmuxBackendCore               |   |
|  | - NotificationStateService                       |   |
|  | - WorkerRuntimeStateService                      |   |
|  | - EventBus / EventLog tailer                     |   |
|  | - DiffService (git primitives from reviewChanges)|   |
|  | - TerminalBridge (node-pty + tmux attach)        |   |
|  |                                                  |   |
|  | ~/.hydra/sessions.json, notifications.json,      |   |
|  | worker-runtime-state.json, events.jsonl          |   |
|  +--------------------+-----------------------------+   |
|                       | HTTP/WS on 127.0.0.1            |
+-----------------------|---------------------------------+
                        v
+---------------- Electron renderer ---------------------+
| React UI: mission control, terminal, diff, copilot,     |
| notifications. Talks only to HydraControlClient.        |
+--------------------------------------------------------+
                        |
                        v
                 tmux sessions + git worktrees
```

The sidecar should import the engine (`SessionManager`, `TmuxBackendCore`,
notification/runtime stores) rather than spawn CLI commands. Spawning the CLI is a
debug fallback only: it is slower, stringly typed, and loses typed event/control
boundaries. The current CLI remains the de-facto API contract for fields and verbs.

**THE CRUX - the B-compatible interface**

Define a transport-neutral TypeScript client and make the renderer depend only on it:

```ts
export interface HydraControlClient {
  listSessions(): Promise<HydraSessionList>;
  createWorker(input: CreateWorkerInput): Promise<CreateWorkerResult>;
  createCopilot(input: CreateCopilotInput): Promise<CreateCopilotResult>;
  startSession(session: string, kind: 'worker' | 'copilot', opts?: StartInput): Promise<SessionResult>;
  stopWorker(session: string): Promise<SessionResult>;
  deleteSession(session: string, kind: 'worker' | 'copilot', opts?: DeleteInput): Promise<SessionResult>;
  renameSession(session: string, kind: 'worker' | 'copilot', name: string): Promise<SessionResult>;
  restoreSession(session: string): Promise<SessionResult>;
  getLogs(session: string, kind: 'worker' | 'copilot', lines: number): Promise<LogResult>;
  sendMessage(session: string, kind: 'worker' | 'copilot', message: string): Promise<SendResult>;
  broadcastToWorkers(message: string): Promise<BroadcastResult>;
  listNotifications(filter: NotificationFilter): Promise<NotificationList>;
  markNotificationRead(id: string): Promise<NotificationResult>;
  clearNotifications(filter: NotificationFilter): Promise<NotificationClearResult>;
  getDiff(session: string): Promise<DiffSummary>;
  getFileSnapshot(input: FileSnapshotInput): Promise<FileSnapshot>;
  subscribeEvents(input: EventSubscriptionInput): AsyncIterable<HydraEvent>;
  subscribeNotifications(input: NotificationSubscriptionInput): AsyncIterable<NotificationSnapshot>;
  attachTerminal(input: TerminalAttachInput): TerminalChannel;
}

export interface HydraTransport {
  request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes>;
  stream<TReq, TEvent>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvent>;
  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel;
}
```

Fork A implements this with `LoopbackHttpWsTransport` from renderer to sidecar. An
optional `InProcessTransport` is useful for tests and for a future single-process dev
mode. Fork B replaces only the transport implementation with `RestWsTransport`
pointing at `hydrad`; UI callers and service verbs do not change.

Service-to-code mapping:

| Service verb | Current repo grounding |
| --- | --- |
| `listSessions` | `SessionManager.sync()` plus `WorkerRuntimeStateStore.get()` as in `src/cli/commands/list.ts` |
| `createWorker` | `SessionManager.createWorker()` / `createDirectoryWorker()` as in `worker create` |
| `createCopilot` | `SessionManager.createCopilotAndFinalize()` as in `copilot create` |
| `start/stop/delete/rename/restore` | `SessionManager` methods at the existing CLI command sites |
| `getLogs` | `TmuxBackendCore.capturePane()` as in `worker logs` / `copilot logs` |
| `sendMessage` | `TmuxBackendCore.sendMessage()` plus runtime-state mark from `worker send` |
| `subscribeEvents` | `EventLog.read({ after })` and future push from `HydraEventBus` |
| `notifications` | `NotificationStore` / `NotificationStateService` |
| `getDiff` / `getFileSnapshot` | headless extraction of git logic from `reviewChanges.ts` |
| `attachTerminal` | terminal spike: `node-pty` + `tmux attach` + WebSocket + xterm.js |

Event model:

- Introduce a sidecar-level `HydraEventBus` with `append(input)`, `read(after)`, and
  `subscribe(after, filters)`. In Fork A, writes from sidecar-controlled operations go
  through `EventLog.append()` and synchronously emit the returned event on an
  in-process `EventEmitter`.
- Keep a single compatibility tailer for external writers (CLI, VS Code extension,
  hooks) that already append to `events.jsonl`. The tailer tracks `seq`, tolerates an
  incomplete tail like `EventLog.read({ tolerateIncompleteTail: true })`, and emits
  events into the same bus. Existing `fs.watchFile` polling is centralized here rather
  than repeated in every UI-facing service.
- Refactor desktop-facing notification/runtime projectors to subscribe to the bus.
  They can still load snapshots from `notifications.json` and
  `worker-runtime-state.json`, but clients receive push updates from
  `subscribeNotifications` / `subscribeEvents`, not polling.
- Fork B keeps the event log as durable storage but moves the bus into `hydrad`;
  WebSocket fan-out becomes the only client subscription mechanism.

Auth slots:

- Every transport request already accepts `AuthContext`. In Fork A, Electron main
  generates a random per-launch token, passes it to the renderer through secure IPC,
  binds sidecar HTTP/WS to `127.0.0.1`, and rejects missing/incorrect bearer tokens and
  non-local `Origin` headers.
- Fork B replaces the ephemeral token with configured local credentials or user login,
  but handlers still receive the same `AuthContext` and can add per-verb authorization
  without changing renderer calls.

Live state and propagation in Fork A:

- Durable state remains `~/.hydra/sessions.json`, `archive.json`, `notifications.json`,
  `worker-runtime-state.json`, `events.jsonl`, and git worktrees. `HYDRA_HOME` remains
  the isolation point for tests and alternate profiles.
- On startup the sidecar calls `SessionManager.sync()` to reconcile persisted sessions
  with tmux reality, matching the CLI `list` path.
- Mutations call `SessionManager` and `TmuxBackendCore`, which already emit lifecycle
  events like `worker.created`, `worker.started`, `worker.stopped`, `worker.deleted`,
  `copilot.created`, and `session.id.captured`.
- Runtime and notification state are projections. `worker.runtime.changed` is emitted
  from `workerRuntimeState.ts`; `notify.created/read/cleared` are emitted from
  `notifications.ts`. The desktop UI should render from snapshots plus event deltas,
  not infer status from terminal text.

Terminal integration:

- Sidecar owns the terminal bridge. Renderer opens `ws://127.0.0.1:<port>/terminal`
  with session, mode (`interactive` or `mirror`), dimensions, and token.
- Interactive mode spawns `node-pty` with `tmux attach -t <session>`, forwards raw PTY
  output to xterm.js, and forwards input/resize back to the PTY.
- Mirror mode uses `capture-pane` backfill plus `pipe-pane` or periodic capture for
  read-only observers so a second UI does not fight over tmux's single grid size.
- Productionization must bake in the spike findings: set tmux `status off` or account
  for the lost row, coalesce output/backpressure large writes, preserve/restore
  `node-pty` `spawn-helper` execute bits, and ship per-platform prebuilds.

A -> B migration:

| Area | Fork A sidecar | Fork B daemon | What stays stable |
| --- | --- | --- | --- |
| Process owner | Electron spawns sidecar, exits with app | `hydrad` runs independently | `HydraAppService` handlers |
| Transport | loopback HTTP/WS with launch token | REST + WS with durable auth | `HydraControlClient` and request/stream shapes |
| Engine access | sidecar imports `src/core` | daemon imports `src/core` | `SessionManager`, `TmuxBackendCore`, stores |
| Events | EventEmitter plus JSONL compatibility tailer | daemon EventBus with WS fan-out | `HydraEvent` schema and `seq` cursors |
| Terminal | sidecar `node-pty` bridge | daemon `node-pty` bridge | xterm protocol and terminal channel |
| State | `~/.hydra` JSON + tmux + worktrees | same initially; DB optional later | domain snapshots and event contract |
| CLI | talks to files/core as today | can become API client later | CLI JSON contract fields |
| VS Code | shares files and tmux as today | can become API client later | commands and session identity |
| Auth | ephemeral localhost bearer token | persistent token/user auth | `AuthContext` parameter on transport |

Security posture:

- Fork A is local-only: bind to `127.0.0.1`, random port, per-launch bearer token,
  strict origin checks, no unauthenticated terminal endpoint, no LAN listen flag.
- Redaction already exists in `EventLog` for sensitive payload keys; desktop should
  preserve that and avoid writing raw prompts/diffs into event payloads.
- Terminal input is high privilege because it types into tmux. Require token auth,
  session existence checks, explicit interactive ownership, and read-only mirrors for
  secondary clients.
- File snapshot/diff endpoints must be constrained to known session workdirs and
  normalized relative paths. Do not expose arbitrary filesystem reads from renderer
  payloads.

Milestones and effort:

| Milestone | Deliverable | Estimate |
| --- | --- | --- |
| 0. Interface extraction | `HydraControlClient`, transport types, service DTOs, headless diff service | 3-4 days |
| 1. Sidecar skeleton | Electron main spawns sidecar, health check, token, list/create/send/logs APIs | 1 week |
| 2. Mission Control | React board, session detail, notification badges, event streaming | 1 week |
| 3. Terminal | packaged node-pty bridge, xterm.js, resize/reconnect, mirror mode | 1-1.5 weeks |
| 4. Diff review | changed-file list, snapshots, side-by-side diff, push/PR handoff | 1 week |
| 5. Hardening | packaging smoke on clean machines, tray, settings, error states, docs | 1-1.5 weeks |

Total v1: roughly 5-6 engineer-weeks for a credible local desktop MVP, assuming one
engineer familiar with Hydra and one frontend/product engineer.

### 3. 主要风险与取舍 (Risks & trade-offs)

Top risks:

- **`node-pty` packaging is the highest-probability failure.** The spike already found
  a macOS `spawn-helper` execute-bit problem. Retire this first with a minimal packaged
  Electron app that opens a real Hydra worker terminal on macOS arm64/x64 and Linux,
  from a clean install.
- **Event consistency across desktop, CLI, and VS Code.** In-process events alone miss
  external writers; file polling everywhere recreates today's scattered watchers. The
  compromise is one sidecar tailer plus an EventBus now, then daemon-owned fan-out
  later. Retire this with a test that creates/updates sessions from CLI while desktop
  is open and verifies event order by `seq`.
- **Diff review can become an editor clone.** Keep v1 focused on review and ship:
  changed files, side-by-side diff, open folder, push/PR handoff. Do not build a full
  IDE. Extract the existing VS Code git logic, but keep rendering desktop-native.
- **Electron footprint is a real trade-off.** The bet is that Node engine reuse,
  terminal native modules, and team velocity matter more than binary size for v1.
  Revisit Tauri only after Fork B exists and the app is a thin API client.
- **Multiple interactive viewers cannot have independent tmux sizes.** Product must
  encode one interactive owner per worker and mirrors for observers. Do not spend v1
  time trying to defeat tmux's single grid.

Decisions I am least sure about:

- Whether the sidecar should expose HTTP/WS in v1 or use Electron IPC plus a WS only
  for terminals. I still recommend HTTP/WS because it proves the B seam earlier, but
  it adds local auth and port-management work sooner.
- Whether diff review belongs in v1 or should be replaced by "open in VS Code" for the
  first private beta. I include it because the desktop app is not credible as mission
  control without review, but it should stay intentionally smaller than an editor.
- Whether CLI should remain file/core-backed through all of Fork A. I recommend yes;
  making the CLI depend on a sidecar would break scripts and headless workflows.

Executive recommendation: build Fork A as an Electron app with a spawned Node sidecar that imports Hydra's existing headless core, and make every renderer call go through a `HydraControlClient` backed by a request/stream transport. This gets a useful local desktop app quickly, keeps the CLI and VS Code extension working against the same tmux/file/event reality, and proves the Fork B migration: when `hydrad` arrives, replace loopback sidecar transport with authenticated REST/WebSocket transport while leaving product screens, DTOs, terminal protocol, and service handlers intact.
