# Hydra Desktop App — FINAL Reconciled Proposal (Fork A now, B-compatible seam)

**Status:** Authoritative. Supersedes both team `PROPOSAL.md` drafts. Reconciled after two cross-reviews; the two independent teams reached ~90% convergence, and the five genuine deltas below are now resolved by orchestrator decision.

**One line:** Ship an **Electron** app whose renderer is a **thin loopback API client** talking only to a **plain forked Node sidecar** that `import`s the already-headless `src/core` in-process. All domain calls go through one **`HydraControlClient` over an injected `HydraTransport`** (the 3-method swappable waist). Graduating to Fork B (`hydrad`) is "**swap the transport + add auth + supervise a daemon**," never a rewrite — because engine, `~/.hydra` state, terminal bridge, and the CLI JSON contract all sit in the *unchanged* column.

**Grounding:** `src/core/sessionManager.ts`, `types.ts` (`MultiplexerBackendCore`), `tmux.ts`, `events.ts`, `notificationStateService.ts`, `workerRuntimeStateService.ts`; CLI under `src/cli/commands/**` + `docs/cli-contract.md`; diff logic in `src/commands/reviewChanges.ts`; the DI precedent in `src/utils/backendFactory.ts`; the terminal spike in `spikes/terminal-bridge/FINDINGS.md`.

---

## 1. 产品形态 (Product form)

### What the desktop app IS
A **mission-control cockpit for parallel AI coding agents** — the graphical front for the same engine the CLI drives today. It is **not** "VS Code without the editor" and not a terminal emulator; the durable runtime is still tmux + Hydra's local state. Primary surfaces:

| Surface | What it shows | Backed by (today's code) |
|---|---|---|
| **Mission Control** (home) | Dense grid grouped by repo / Local Tasks: worker number, branch·task·agent, lifecycle (`running`/`stopped`), runtime projection (`unknown`/`running`/`idle`/**`needs-input`**/`error`), unread count, dirty-diff count, last-event time. Replaces the VS Code tree as the primary screen. | `SessionManager.sync()` → `SessionState`; `WorkerRuntimeStateService`; `NotificationStateService` |
| **Per-worker Terminal** | Full-fidelity xterm.js attached to the worker's tmux session (color, TUI, mouse, resize). One interactive owner; secondary views are read-only mirrors. | Spike: `node-pty` → `tmux attach` → WS → xterm.js |
| **Diff Review** | Headless port of `reviewChanges.ts`: base-ref chain → changed-file list → side-by-side diff → commit/push/PR handoff. | `src/commands/reviewChanges.ts`; `WorkerInfo.workdir`/`repoRoot`/`branch`; `src/core/git.ts` |
| **Copilot View** | Cross-repo control center (not repo-scoped): a copilot's **managed workers and the repos they touch** (per AGENTS.md "Copilot vs repos"), its terminal, create/send/broadcast/restore. | `CopilotInfo`; `WorkerInfo.copilotSessionName` |
| **Attention Inbox** | Unread-first notifications (`complete`/`needs-input`/`error`/`blocked`/`info`) with `open-session` / `review-diff` actions. Roadmap item #4, given a real UI. | `notifications.json`; `events.jsonl`; `HydraNotification` |

### Shell choice: **Electron** (not Tauri)
The binding constraint is **Node engine reuse**, not footprint: the engine, CLI, terminal bridge, and `node-pty` are all Node, so Electron keeps native-module packaging, tray, auto-update, deep links, and renderer↔Node bootstrap in one JavaScript toolchain. Tauri's smaller footprint is real, but it would force us to **ship a Node sidecar anyway** (or port the engine to Rust) — giving up the existing codebase's main advantage while making `node-pty` packaging *harder*. The shell is a **Fork-A-only, reversible** decision (Fork B's `hydrad` is headless Node with no shell), so nothing here taxes the daemon later; revisit Tauri only after B exists and the app is a thin API client. Audience = developers already running VS Code (Electron) + tmux + several heavyweight agents — the least footprint-sensitive user base there is.

### Coexistence with CLI and VS Code extension
**Additive; all three drive the same `~/.hydra` state and interoperate by construction.**
- **CLI stays first-class** and remains the compatibility contract (`docs/cli-contract.md`). The sidecar imports the same core classes rather than shelling out, but its public verbs mirror CLI JSON fields so scripts, copilots, and desktop speak one domain language. A worker created in either shows up in the other (shared `HYDRA_HOME`, file+lock coordination). In Fork B the CLI *can* become an API client — but stays file/core-backed through all of Fork A so headless scripts never depend on a running app.
- **VS Code extension stays** as the editor-native surface (in-editor terminal attach, SCM diff). Later it can become another `HydraControlClient` client — but not before desktop v1 ships.
- **No new source of truth.** The desktop app introduces zero private state.

### Key v1 UX flow (each step maps to a service verb — §2)
Open Mission Control (`SessionManager.sync()` + subscribe) → **create** worker (repo·branch·agent·base·task → `createWorker`/`createDirectoryWorker`, tile appears on the `worker.created` event, not a poll) → **monitor** (`worker.runtime.changed` / `notify.created` push status + inbox) → open **terminal** (`attachTerminal` WS) → **review** diff (`getDiff`) → **ship** (`git push -u` + `gh pr create` handoff) or `stopWorker`/`deleteWorker`.

### MVP scope — the line, drawn explicitly
**In v1 (local-only, single machine):** Electron app + plain Node sidecar; Mission Control board; create/start/stop/delete/rename for worker & copilot; terminal attach + read-only mirror; logs capture; send/broadcast; Attention Inbox + tray badge; read-only Diff Review; settings (default agent, agent commands); **loopback HTTP/WS + launch-token auth from day one**; macOS + Linux; signed/notarized packaging with `node-pty` prebuilds + auto-update.

**Explicitly later:** long-running daemon / remote / multi-device (**= Fork B**); local web dashboard for non-Electron browsers (nearly free once the loopback speaks HTTP/WS); multi-window tmux tabs & per-pane UI surfaces (spike §5); encrypted `share`-bundle UX (today's manual GCS handoff, generalized); built-in PR creation beyond a `gh`/browser handoff; **Windows** (tmux is the runtime — macOS/Linux only per AGENTS.md — until a multiplexer backend or WSL story is productized separately).

---

## 2. 技术方案 (Technical plan)

### Architecture (Fork A)
```
┌─ Electron app (sidecar is a plain forked Node process; dies with the app) ──────┐
│                                                                                 │
│  ┌───────────────────────────┐         ┌──────────────────────────────────┐    │
│  │ Renderer (Chromium)        │         │ Main process (Node)              │    │
│  │  React UI                  │         │  • window / tray / auto-update   │    │
│  │  • mission control grid    │         │  • child_process.fork(sidecar)   │    │
│  │  • xterm.js terminals      │         │  • mints per-launch bearer token │    │
│  │  • diff review / inbox     │         │  • IPC → renderer: {url, token}  │    │
│  │                            │         └───────────────┬──────────────────┘    │
│  │  HydraControlClient        │  IPC (bootstrap only)   │ fork                   │
│  │    └─ HydraTransport ──────┼── loopback ────────────┐│  (bundled pinned node) │
│  └────────────────────────────┘  127.0.0.1:<rand>      ▼▼                        │
│                                   Bearer <token>  ┌──────────────────────────┐   │
│                          request  /v1/*      ────▶│ SIDECAR = node sidecar.js│   │
│                          stream   /v1/events ────▶│  • auth + Origin mw      │   │
│                          openTerm /v1/terminal ──▶│  • request/stream router │   │
│                                                   │  ┌────────────────────┐  │   │
│                                                   │  │ HydraAppService     │  │   │
│                                                   │  │  import src/core    │  │   │
│                                                   │  │  SessionManager     │  │   │
│                                                   │  │  Notif/RuntimeStores│  │   │
│                                                   │  │  EventBus + tailer  │  │   │
│                                                   │  │  DiffService        │  │   │
│                                                   │  │  node-pty⇄tmux attach│ │   │
│                                                   │  └─────────┬──────────┘  │   │
│                                                   └────────────┼─────────────┘   │
└────────────────────────────────────────────────────────────────┼───────────────┘
                                    child_process / fs            │
                ┌───────────────────────────┬─────────────────────┼──────────────┐
                ▼                           ▼                     ▼               ▼
        ~/.hydra/*.json            events.jsonl            tmux server      git worktrees
        sessions.json          (ALSO written by CLI      = the real        ~/.hydra/
        notifications.json      + VS Code + hooks →       runtime          worktrees/…
        worker-runtime-state    single tailer)            (1 sess/agent)
```

### Engine hosting — plain forked Node sidecar (NOT `utilityProcess`)
The sidecar is a **standalone Node entrypoint**: `node sidecar.js` today, `node hydrad.js` tomorrow — the *same program*, Electron-free, headless-testable. Electron's main process spawns it with `child_process.fork()` and monitors it (health check + restart). We reject `utilityProcess.fork()` because it couples both the spawn API *and* the Node/V8 ABI to Electron, forcing a re-host step to become a daemon and blocking headless sidecar tests. The engine embeds trivially — the CLI proves it in two lines (`new TmuxBackendCore(); new SessionManager(backend)` — `src/cli/commands/whoami.ts:32`). This is a **~1-file decision (the spawner)**; everything above the fork is identical either way because the data plane is loopback HTTP/WS, not Electron IPC.

**Condition (non-negotiable):** a plain child must **not** inherit the user's system Node. **Bundle a version-pinned Node runtime with the app, pin it to hydrad's target Node, and build `node-pty` against that single ABI.** This keeps `node-pty` a one-ABI problem and directly serves risk #1 (§3). Embed via `import core`, never `spawn hydra` (shelling the CLI is a debug fallback only — slower, stringly-typed, loses typed event/control boundaries).

### THE CRUX — the B-compatible interface (two layers + a server handler)
One domain interface, written **once**, over a thin swappable transport — the same DI the codebase already uses for the multiplexer (`createBackendFromConfig()` returns a concrete `MultiplexerBackend` while `SessionManager` depends only on the `MultiplexerBackendCore` interface, `src/core/types.ts:24`). A `transportFactory` mirrors that `backendFactory`.

```ts
// (1) Domain client — the ONLY thing the renderer imports. Verbs mirror cli-contract.md.
//     Written ONCE as verb → transport.request(op, payload). No per-transport duplication.
export interface HydraControlClient {
  listSessions(): Promise<HydraSessionList>;                                   // SessionManager.sync + runtime store
  createWorker(i: CreateWorkerInput): Promise<CreateWorkerResult>;            // createWorker/createDirectoryWorker
  createCopilot(i: CreateCopilotInput): Promise<CreateCopilotResult>;         // createCopilotAndFinalize
  startSession(s, kind, opts?): Promise<SessionResult>;                        // start{Worker,Copilot}
  stopWorker(s): Promise<SessionResult>;                                       // stopWorker
  deleteSession(s, kind, opts?): Promise<SessionResult>;                       // delete{Worker,Copilot}(+deleteFiles)
  renameSession(s, kind, name): Promise<SessionResult>;                        // rename{Worker,Copilot}
  restoreSession(s): Promise<SessionResult>;                                   // restore{Worker,Copilot}
  getLogs(s, kind, lines): Promise<LogResult>;                                 // TmuxBackendCore.capturePane
  sendMessage(s, kind, msg): Promise<SendResult>;                              // TmuxBackendCore.sendMessage
  broadcastToWorkers(msg): Promise<BroadcastResult>;                           // worker send --all
  listNotifications(f) / markNotificationRead(id) / clearNotifications(f): …   // NotificationStore
  getDiff(s): Promise<DiffSummary>;                                            // headless reviewChanges.ts
  getFileSnapshot(i: FileSnapshotInput): Promise<FileSnapshot>;               // path-constrained (see below)
  subscribeEvents(i): AsyncIterable<HydraEvent>;                               // EventBus (was events --follow)
  subscribeNotifications(i): AsyncIterable<NotificationSnapshot>;              // NotificationStateService
  attachTerminal(i: TerminalAttachInput): TerminalChannel;                     // node-pty + tmux attach
}

// (2) Transport — the swappable 3-method WAIST. A→B reimplements ONLY this.
export interface HydraTransport {
  request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes>;
  stream<TReq, TEvt>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvt>;
  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel;
}
```

- **Fork A transport:** `LoopbackHttpWsTransport` (renderer → sidecar). `InProcessTransport` falls out for free for tests / single-process dev.
- **Fork B transport:** `RestWsTransport` pointed at `hydrad`. **UI callers and domain verbs do not change** — only the injected `HydraTransport` impl does.
- **Server side:** the in-proc engine calls live in **`HydraAppService`** inside the sidecar — it receives `request(op, payload)`, dispatches to `SessionManager`/`TmuxBackendCore`/stores, and is *identical* in the Fork B daemon. (This is why there is no client-side "local service": in a spawned-sidecar app the renderer always crosses a transport to reach the engine.)

### Data plane — all verbs and streams over loopback HTTP/WS from day one
Every domain call and stream rides `LoopbackHttpWsTransport`; **Electron IPC is used ONLY for the bootstrap handoff** of `{loopbackUrl, launchToken}` from main → renderer. Rationale: if the control plane rode IPC, every call site would be `ipcRenderer.invoke`-shaped and would have to be *rewritten* to HTTP for B — the exact rewrite the brief forbids. The "extra" auth + port work is **required B work**; doing it in Fork A is *how the seam is proven*, and it's bounded (~1 day: bind + bearer middleware + `Origin` check — the same middleware B hardens). Bonus: a loopback HTTP server makes a **local web dashboard nearly free** (browser → `127.0.0.1` + token), de-risking the eventual web client.

### Event model — `EventBus` + one compatibility tailer (replaces `fs.watchFile` polling)
The engine already funnels every mutation through one chokepoint: `EventLog.append()` (`events.ts:68`). The sidecar wraps it in a `HydraEventBus` with `append(input)` / `read(after)` / `subscribe(after, filters)`.
```
Fork A:  sidecar mutation ─▶ EventLog.append() ─┬─▶ EventBus.emit()  (in-proc, INSTANT)
                                                │        → subscribeEvents / subscribeNotifications (WS push)
         CLI / VS Code / hook writes jsonl ─▶ ONE seq-cursored tailer ┘  (tolerateIncompleteTail)
```
- Sidecar-originated writes emit **synchronously** on an in-proc `EventEmitter` — no 1000 ms poll for interactive actions.
- **One** compatibility tailer (centralized here, not scattered across every UI service as today) handles genuinely external writers, tracking `seq` and tolerating an incomplete tail like `EventLog.read({ tolerateIncompleteTail: true })`. **Dedupe by `seq`** so a self-emitted event that the tailer also re-reads fires once.
- Desktop notification/runtime **projectors subscribe to the bus**; they still load snapshots from `notifications.json` / `worker-runtime-state.json`, but clients receive **push deltas**, not polls. Render from snapshot + event delta — never infer status from terminal text.
- **Fork B:** the bus moves into `hydrad`, which becomes the single writer; the tailer disappears and **WS fan-out is the only subscription mechanism**. `HydraEvent` schema + `seq` cursors are unchanged.

### Terminal integration + packaging (risk #1)
Straight from the validated spike: `node-pty` runs `tmux attach`, tmux owns screen state, reconnect repaints the current screen (~1.5 ms localhost round-trip). Renderer opens `ws://127.0.0.1:<port>/terminal` with `{session, mode: 'interactive'|'mirror', dims, token}`. **Interactive** spawns the PTY and forwards raw output + input/resize; **mirror** uses `capture-pane` backfill + `pipe-pane`/periodic capture for read-only observers so a second UI doesn't fight tmux's single grid (spike §3). Productionization bakes in: `status off` (or account for the −1 row), output coalescing/backpressure on chatty TUIs, **preserve/restore the `spawn-helper` execute bit**, and per-platform prebuilds (`darwin-arm64`/`darwin-x64`/`linux-*`). node-pty is built against the **one** bundled-Node ABI (see engine hosting).

### A → B migration — engine / state / terminal / contract stay UNCHANGED
| Area | Fork A (sidecar) | Fork B (`hydrad` daemon) | What stays stable |
|---|---|---|---|
| Process owner | Electron forks `node sidecar.js`, exits with app | `node hydrad.js` under launchd/systemd, multi-client | **`HydraAppService` handlers** |
| Transport | `LoopbackHttpWsTransport` + launch token | `RestWsTransport` + durable auth | **`HydraControlClient` + request/stream shapes** |
| Engine access | sidecar imports `src/core` | daemon imports `src/core` | **`SessionManager`, `TmuxBackendCore`, stores** |
| Events | EventEmitter + one JSONL tailer | daemon EventBus, WS fan-out (single writer) | **`HydraEvent` schema + `seq` cursors** |
| Terminal | sidecar `node-pty` bridge | daemon `node-pty` bridge | **xterm protocol + terminal channel** |
| State | `~/.hydra` JSON + tmux + worktrees | same initially (DB optional later) | **domain snapshots + event contract** |
| CLI | file/core-backed (unchanged) | can become API client | **CLI JSON contract fields** |
| VS Code | shares files + tmux (unchanged) | can become API client | **commands + session identity** |
| Auth | ephemeral loopback bearer | persistent token / user auth | **`AuthContext` on every transport call** |

The four heaviest assets — **engine, state, terminal, contract** — are all in the "stays stable" column. Fork B = swap the transport + harden auth + supervise a daemon.

### Security posture
Local-only, auth-ready by construction: bind `127.0.0.1`, random port, **per-launch bearer token** (handed to the renderer via secure IPC), strict `Origin` checks, **no unauthenticated terminal endpoint**, no LAN-listen flag. `EventLog` payload redaction (`SENSITIVE_KEY_PATTERN`, `events.ts:52`) is preserved — never write raw prompts/diffs into event payloads. **Terminal input is high-privilege** (it types into tmux): require token auth + session-existence check + explicit interactive ownership + read-only mirrors for secondary clients. **`getDiff`/`getFileSnapshot` are path-constrained** to the session's known `workdir`: normalize paths, **reject `../` and absolute paths**, no arbitrary filesystem reads from renderer payloads (closes the read-any-file hole). Fork B flips loopback→TLS and launch-token→issued/rotated tokens in the one middleware that already exists; callers never change.

### Milestones & effort
| Milestone | Deliverable | Estimate |
|---|---|---|
| 0. Interface extraction | `HydraControlClient`, `HydraTransport`, DTOs, `transportFactory`, headless `DiffService` | 3–4 d |
| 1. Sidecar skeleton | Electron main forks `node sidecar.js` (bundled pinned Node), health check, token handoff, list/create/send/logs verbs | 1 wk |
| 2. Mission Control | React board, session detail, notification badges, **EventBus** streaming (no poll) | 1 wk |
| 3. Terminal | packaged `node-pty` bridge, xterm.js, resize/reconnect, mirror mode | 1–1.5 wk |
| 4. Diff review | changed-file list, path-constrained snapshots, side-by-side diff, push/PR handoff | 1 wk |
| 5. Hardening | **code-signing + Apple notarization + auto-update (~1 wk)**, clean-box packaging smoke, tray, settings, error states, docs | 1.5–2 wk |

**Effort (state both units, don't double-count):**
- **Labor: ~8–10 engineer-weeks** (planning **floor = 8**).
- **Calendar: ~5–6 weeks with two engineers in parallel** (one Hydra-core, one frontend/product).

Two engineers over ~5–6 calendar weeks at **partial parallelism** (interface extraction and packaging serialize; they can't both run fully parallel) *is* ~8–10 engineer-weeks of labor — the same estimate in different units, not a contradiction. The earlier "5–6 vs 8–10" gap was this units artifact plus one genuine omission: **code-signing / notarization / auto-update (~1 week)**, now line-itemed in M5.

---

## 3. 主要风险与取舍 (Risks & trade-offs)

1. **`node-pty` native packaging — highest-probability failure.** The spike already hit a macOS `spawn-helper` execute-bit bug (`posix_spawnp failed`). *Retire first:* a minimal packaged Electron app that opens a **real Hydra worker terminal from a clean install on macOS arm64/x64 + Linux**, `node-pty` built against the single bundled-Node ABI, execute bit preserved via `asarUnpack` + `postinstall` (`scripts/ensure-pty-helper.js` is the reference fix), per-platform prebuilds, clean-box CI smoke.
2. **Event consistency across desktop / CLI / VS Code.** In-process events alone miss external writers; polling everywhere recreates today's scattered watchers. *Retire:* one tailer + EventBus now (daemon-owned fan-out later) with a test that creates/updates sessions from the CLI while desktop is open and **verifies event order + no-dup by `seq`**.
3. **Diff review becoming an editor clone.** *Retire:* v1 = review + ship only (changed files, side-by-side diff, open folder, push/PR handoff); extract the git logic from `reviewChanges.ts`, render desktop-native, do not build an IDE.
4. **tmux single-grid sizing** if a human `tmux attach`es a worker the app is viewing. *Retire:* one interactive owner per worker + read-only mirrors for observers; don't spend v1 defeating tmux's single grid.
5. **Electron footprint / Windows gap.** Footprint is an accepted, reversible trade (revisit Tauri only after B, as a thin client). Windows is out of v1 because tmux is the runtime (macOS/Linux) — gate on a separate multiplexer/WSL story.

**Decisions we were least sure about, now settled:**
- **Engine hosting** was the single residual post-review disagreement (the two teams swapped seats). **Settled: plain forked Node sidecar**, decided on the project's own priorities — **B-portability + headless-testability** — with the bundled-pinned-Node condition. It's a ~1-file (spawner) choice, cheap to revisit if packaging surprises.
- **Data plane over HTTP/WS vs IPC:** settled on **full loopback HTTP/WS** (IPC for bootstrap only) — it proves the B seam and buys a near-free local web dashboard; the auth/port cost is required B work done early, not waste.
- **CLI stays file/core-backed through all of Fork A** — making it depend on a running sidecar would break headless scripts.

---

## Executive recommendation
Build Fork A as an **Electron app with a plain forked Node sidecar** (`node sidecar.js` → `node hydrad.js`) that imports Hydra's existing headless `src/core`, and make **every** renderer call go through a **`HydraControlClient` over an injected `HydraTransport`** (loopback HTTP/WS in Fork A, Electron IPC only for the token handoff), with the in-proc engine calls held server-side in `HydraAppService`. Feed live state from an in-proc `EventBus` off `EventLog.append()` plus one `seq`-cursored tailer for external writers, reuse the spike's `node-pty`+`tmux attach` terminal bridge verbatim, and add path-constrained `getDiff`/`getFileSnapshot` extracted from `reviewChanges.ts`. Guard the seam with the existing `npm run smoke:cli-contract` as a B-compat DTO check. This lands a credible local desktop MVP in **~8–10 engineer-weeks of labor (≈ 5–6 calendar weeks with two engineers; planning floor 8)**, and makes Fork B a **"swap the transport + add auth + supervise a daemon"** exercise — because engine, `~/.hydra` state, terminal bridge, and CLI contract never move. Fund **node-pty native packaging with clean-box CI first** and refuse to defer it; everything else is additive and reversible.
