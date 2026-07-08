# Hydra Desktop App — Design Proposal (Fork A now, B-compatible seam)

**Position in one line:** Ship an **Electron** desktop app whose renderer is already a **thin loopback API client**, backed by a **Node sidecar that `import`s `src/core` in‑process**. Define one `HydraService` interface (verbs mirror the existing `docs/cli-contract.md` JSON) whose *only* Fork‑A→B change is swapping the injected transport — the same move the codebase already makes for the tmux backend in `src/utils/backendFactory.ts`.

This doc is deliberately opinionated. Where I'm least sure, §3 says so.

---

## 1. 产品形态 (Product form)

### What the desktop app IS

A **mission‑control cockpit for parallel AI coding agents** — the graphical front for the same engine the CLI drives today. It is *not* a terminal emulator or an IDE; it's a fleet dashboard with a live terminal per agent. Primary surfaces:

| Surface | What it shows | Backed by (today's code) |
|---|---|---|
| **Mission Control** (home) | Worker/copilot grid + status board: per‑session `status` (running/stopped), `runtimeState` (running / idle / **needs‑input** / error), unread badge, repo·branch·agent, attach state. Group by copilot / repo / task folder. | `SessionManager.sync()` → `SessionState`; `WorkerRuntimeStateService`; `NotificationStateService` |
| **Per‑worker Terminal** | Full‑fidelity xterm.js attached to the worker's tmux session (colors, TUI, mouse, resize). | Terminal‑bridge spike: `node-pty` → `tmux attach` → WS → xterm.js (`spikes/terminal-bridge/`) |
| **Diff Review** | `git -C <workdir> diff` / `diff --stat` / `log main..HEAD` per code worker; file tree + hunks; "ship" affordance. | `WorkerInfo.workdir`/`repoRoot`/`branch`; `src/core/git.ts` |
| **Copilot View** | A copilot's **managed workers and the repos they touch** (not the copilot's own `workdir` — per AGENTS.md "Copilot vs repos"), its terminal, and the create‑worker launcher. | `CopilotInfo`; `WorkerInfo.copilotSessionName` |
| **Attention Inbox** | Unread‑first notifications (`complete` / `needs-input` / `error` / `blocked` / `info`) with `open-session` / `review-diff` actions. This is the roadmap's item #4 ("Attention Inbox"), finally given a real UI. | `notifications.json`; `HydraNotification`; `notify` verbs |

### Shell choice: **Electron** (not Tauri)

**Decision: Electron.** The binding constraint is not footprint — it's that *the entire asset being reused is Node*: `src/core` (11.5k LOC TS), `src/cli` (3k LOC), the terminal bridge, and the `node-pty` native module. Electron's main process **is** a Node runtime, so the engine runs in‑process with zero language or ABI boundary. Justified against Hydra's specifics:

| Criterion | Electron | Tauri | Why it favors Electron here |
|---|---|---|---|
| **Node engine reuse** | Engine runs directly in a Node `utilityProcess` (`import {SessionManager}`) | Rust shell **cannot** host the Node engine → you ship a **bundled Node sidecar anyway** | Tauri saves the webview's disk but still ships Node. You'd maintain **two** runtimes + **two** languages to save ~90 MB. |
| **node-pty native module** (the spike's *only* real prod risk) | Well‑trodden: `electron-rebuild` / `asarUnpack` / execute‑bit preserved (VS Code does exactly this) | Package node-pty inside a sidecar Node binary; you still own the `spawn-helper` chmod + per‑platform prebuilds | Same underlying risk, but a far more trodden path in Electron. |
| **Team skillset** | 100% TS/Node (whole repo, AGENTS.md) | Adds Rust for the window shell | No Rust anywhere in the codebase. |
| **Always-on / tray** | Mature tray/auto‑update ecosystem | Also fine | Push. |
| **Footprint / RAM** | ~120–180 MB installed, heavier RAM | ~5–15 MB, system webview | **Tauri's only real win.** |

**The honest counter‑argument** (and why it loses): footprint is Tauri's win, and the audience — developers already running VS Code (Electron), tmux, and several heavyweight agent processes — is the *least* footprint‑sensitive user base there is. Critically, **the shell choice is a Fork‑A‑only, reversible decision**: Fork B's `hydrad` is a headless Node daemon with no shell at all, so nothing about picking Electron now taxes the daemon later. If footprint ever becomes king (e.g. a menu‑bar‑only build), a Tauri shell can wrap the *same* loopback sidecar without touching the engine.

### Coexistence with the existing CLI and VS Code extension

**Additive, not a replacement — all three drive the same `~/.hydra` state and interoperate by construction.**

- **CLI:** unchanged, first‑class. It stays the scripting/agent surface and the **compatibility contract** (`docs/cli-contract.md`). Desktop and CLI coexist because state is file‑ + lock‑coordinated (`EventLog.withLock`, `sessions.json` lock): a worker created in the app appears in `hydra list` and vice‑versa. In Fork B the CLI graduates to an API client (with in‑proc fallback), a one‑file change.
- **VS Code extension:** keep it. It becomes *one client among several*; its unique value — attach a worker terminal **inside the editor**, SCM diff integration — is worth preserving for VS‑Code‑native users. Its tree/sidebar UI is superseded by the richer desktop grid over time, but we do not kill it. Long‑term it, too, can point at `hydrad`.
- **No new source of truth.** The desktop app introduces *no* private state; it reads/writes the identical `~/.hydra/*.json` + `events.jsonl` + tmux server every other client uses.

### Key UX flows (each maps 1:1 to a service verb — see §2 crux)

1. **Create** — pick repo (registry `owner/name` or path) + branch + agent → `createWorker` → grid tile appears instantly (EventBus, not a 1 s poll).
2. **Monitor** — grid tiles flip to **needs‑input** (from `WorkerRuntimeStateService`) → click tile → live terminal (`attachTerminal`) + inbox item.
3. **Review** — Diff Review reads `git diff` in `workdir`; approve or `sendMessage` a correction.
4. **Ship** — one‑click `git push -u` + `gh pr create` from `workdir`/`branch` (shells out, same as the AGENTS.md flow), then `deleteWorker`.

### v1 (MVP) scope vs later — the line, drawn explicitly

**In v1 (single machine, localhost):** Mission Control grid with live status/runtime/unread; per‑worker terminal (productionized spike); create / stop / start / delete / rename / send; Attention Inbox; read‑only Diff Review; **loopback HTTP/WS transport + launch‑token auth from day one** (this is the seam, not a "later"); macOS + Linux; signed/notarized packaging with node-pty prebuilds.

**Explicitly later:** remote / multi‑device + always‑on background orchestration (**= Fork B**); local web dashboard for non‑Electron browsers (nearly free once the loopback speaks HTTP/WS — see §2); multi‑window tmux tabs and per‑pane UI surfaces (spike §5, deferred until a UX needs it); a graphical *share/handoff* flow (the `hydra share` GCS bundle generalized); Windows (tmux dependency — see §3).

---

## 2. 技术方案 (Technical plan)

### Architecture (Fork A)

```
┌─ Electron app (one process tree; sidecar dies with the app) ───────────────────┐
│                                                                                 │
│  ┌───────────────────────────┐         ┌──────────────────────────────────┐    │
│  │ Renderer (Chromium)        │         │ Main process (Node)              │    │
│  │  React UI                  │         │  • window / tray lifecycle       │    │
│  │  • mission control grid    │         │  • forks the sidecar             │    │
│  │  • xterm.js terminals      │         │  • mints per-launch bearer token │    │
│  │  • diff review / inbox     │         │  • hands renderer {url, token}   │    │
│  │                            │         └───────────────┬──────────────────┘    │
│  │  HydraClient (thin)  ──────┼── loopback ────────────┐│ forks                  │
│  └────────────────────────────┘  127.0.0.1:<rand>      ▼▼                        │
│                                   Bearer <token>  ┌──────────────────────────┐   │
│                                                   │ utilityProcess = SIDECAR │   │
│                          REST  /v1/*  (verbs) ───▶│  Loopback server:        │   │
│                          WS    /v1/events    ───▶│   • auth middleware      │   │
│                          WS    /v1/terminal  ───▶│   • routes → HydraService│   │
│                                                   │  ┌────────────────────┐  │   │
│                                                   │  │ HydraService(LOCAL)│  │   │
│                                                   │  │  import src/core    │  │   │
│                                                   │  │  SessionManager     │  │   │
│                                                   │  │  EventBus(EventLog) │  │   │
│                                                   │  │  node-pty⇄tmux attach│ │   │
│                                                   │  └─────────┬──────────┘  │   │
│                                                   └────────────┼─────────────┘   │
└────────────────────────────────────────────────────────────────┼───────────────┘
                                    child_process / fs            │
                ┌───────────────────────────┬─────────────────────┼──────────────┐
                ▼                           ▼                     ▼               ▼
        ~/.hydra/*.json            events.jsonl            tmux server      git worktrees
        sessions.json          (ALSO written by CLI      = the real        ~/.hydra/
        notifications.json      + agent hooks, out-       runtime          worktrees/…
        worker-runtime-state    of-band → must tail)      (1 sess/agent)
```

**Embedding decision — `import core`, not `spawn CLI`.** The engine is already headless; the CLI proves it embeds in two lines (`new TmuxBackendCore(); new SessionManager(backend)` — see `src/cli/commands/whoami.ts:32`, `archive.ts:46`, etc.). So the sidecar `import`s `src/core` and holds a **single long‑lived `SessionManager`**. We do **not** shell out to `hydra` per operation (process‑spawn latency, no streaming, JSON re‑parse). But we **reuse the CLI's *contract*, not its process**: `HydraService` verbs and payloads mirror `docs/cli-contract.md` field‑for‑field, so (a) the CLI stays a parallel client over the same shapes and (b) Fork B's REST responses are literally the JSON the CLI already emits and tests (`npm run smoke:cli-contract`).

### THE CRUX — the B‑compatible interface

**One interface, two transports, injected at one factory.** The codebase already does exactly this for the multiplexer: `createBackendFromConfig()` returns a `MultiplexerBackendCore`, and `SessionManager` depends only on that interface (`src/core/types.ts:24`). We add the *same* seam one layer up, for the whole service.

```ts
// The contract every client speaks. Verbs derive directly from cli-contract.md
// + SessionManager's public methods. Field names ARE the CLI JSON field names.
interface HydraService {
  // ── request/response (→ REST in Fork B) ─────────────────────────────
  list():                                    Promise<SessionState>          // hydra list
  createWorker(opts: CreateWorkerReq):       Promise<WorkerInfo>            // worker create
  startWorker(s, agent?):                    Promise<WorkerInfo>            // worker start
  stopWorker(s):                             Promise<void>                  // worker stop
  deleteWorker(s, {deleteFiles}):            Promise<void>                  // worker delete
  renameWorker(s, newBranch):                Promise<WorkerInfo>            // worker rename
  createCopilot(opts):                       Promise<CopilotInfo>           // copilot create
  deleteCopilot(s) / renameCopilot / restoreCopilot(s): …                  // copilot …
  getLogs(s, lines):                         Promise<LogsResult>            // worker/copilot logs
  sendMessage(s, text, {all?}):              Promise<void>                  // worker/copilot send
  listNotifications(filter) / readNotification(id) / clearNotifications(f): …  // notify …
  listArchived() / restore(s) / repo*() / config*() / share*(): …

  // ── streaming (→ WebSocket in Fork B) ────────────────────────────────
  subscribeEvents(afterSeq?): AsyncIterable<HydraEvent>          // replaces `events --follow`
  attachTerminal(s, {cols,rows}): DuplexStream                   // node-pty ⇄ tmux attach
}
```

Two concrete implementations, chosen by a `serviceFactory` exactly as `backendFactory` chooses a backend:

```ts
// Fork A — in the sidecar. Direct in-proc calls; zero serialization.
class LocalHydraService implements HydraService {
  constructor(private sm = new SessionManager(new TmuxBackendCore()),
              private bus = new EventBus()) {}
  createWorker(o){ return this.sm.createWorker(o).then(r => r.workerInfo) }
  subscribeEvents(after){ return this.bus.stream(after) }        // in-proc EventEmitter
  attachTerminal(s,g){ return spawnPtyAttach(s,g) }              // the spike, as-is
}

// Fork B — on every client. Same interface; HTTP/WS under the hood. Callers unchanged.
class RemoteHydraService implements HydraService {
  createWorker(o){ return http.post('/v1/workers', o, this.auth) }
  subscribeEvents(after){ return ws.stream('/v1/events?after='+after, this.auth) }
  attachTerminal(s,g){ return ws.duplex('/v1/terminal?session='+s, this.auth) }
}
```

The renderer only ever sees `HydraService`. **In Fork A the renderer already uses `RemoteHydraService` pointed at `127.0.0.1`** — i.e. the client is *already* a thin API client; loopback vs `hydrad` is a URL+token difference. (We deliberately reject Electron's raw IPC for the data plane precisely *because* it would not exercise the transport seam — a tiny amount of extra ceremony now buys a proven B‑seam and a near‑free local web dashboard.)

**The transport abstraction** is therefore not a new framework — it's the standard shape of every verb:
- **Request/response verbs** → today an in‑proc `await`, tomorrow `POST/GET /v1/...` with the identical JSON body/response. The engine method behind the endpoint is *the same call*.
- **`subscribeEvents`** and **`attachTerminal`** → today an in‑proc async iterator / duplex, tomorrow a WS. The terminal bridge is byte‑identical (spike §"Fork A vs Fork B": *"The terminal code ports to Fork B unchanged"*).

**Event‑subscription model — replacing `fs.watchFile` polling.** Today `NotificationStateService` and `WorkerRuntimeStateService` expose `onDidChange(listener): Disposable`, internally driven by `fs.watchFile` at **1000 ms** over `notifications.json` / `events.jsonl` / `worker-runtime-state.json` (`notificationStateService.ts:224`, `workerRuntimeStateService.ts:58`). The whole engine already funnels mutations through one chokepoint: `EventLog.append()` (`events.ts:68`). So:

```
Fork A:  SessionManager mutation ─▶ EventLog.append() ─┬─▶ EventBus.emit()  (in-proc, INSTANT)
                                                       │                    → onDidChange(listener)
                                                       │                    → WS /v1/events (renderer)
         CLI / agent-hook writes events.jsonl ─▶ single file-tailer ────────┘  (out-of-band writers)
```

The `onDidChange` signature **never changes** — we swap its *source* from a 1 s file poll to an in‑proc `EventEmitter`, and keep **one** file‑tailer only for genuinely external writers (CLI, agent completion hooks) that the sidecar doesn't originate. This is the subtle Fork‑A truth: you cannot fully delete file‑watching while the CLI and hooks are separate processes — but you *can* make the engine's own mutations instant and drop the poll‑latency for ~all interactive actions. **In Fork B the daemon becomes the single writer** (CLI/hooks route through it), the file‑tailer disappears, and the same `EventBus` fans out to WS subscribers. Consumers track by `seq` (cursor files already exist: `readCursorFile`/`writeCursorFile`, `events.ts:237`), so a client that missed events replays from its cursor — identical semantics on loopback and WS.

**Where auth slots in.** One middleware, present from day one, hardening later:

- **Fork A:** bind `127.0.0.1` + random port; main process mints a **per‑launch bearer token** and passes it to the renderer; the sidecar rejects any request without it and checks `Origin`. This defends the exact hole the spike flagged (*"auth/origin checks even on localhost"*) — a malicious local web page must not be able to hit the loopback WS and drive tmux.
- **Fork B:** the *same* `Authorization: Bearer` check, now validating **issued/rotated** tokens with device pairing, over TLS. **Callers never change** — they always send the token their transport handed them; only the token's provenance and the socket's TLS change.

**Live state & change propagation in A.** Files remain the source of truth; the EventBus is an accelerator, not an authority. `SessionManager.sync()` reconciles `sessions.json` against live tmux on demand (and on an event nudge); `~/.hydra` writes stay atomic (temp‑write + rename, `withLock`). This is why concurrent CLI/desktop use is safe (§1) and why a desktop crash loses nothing — state is on disk, tmux keeps running.

### Terminal integration + the packaging risk

Straight from the validated spike (`spikes/terminal-bridge/FINDINGS.md`): `node-pty` spawns `tmux attach` → WS → xterm.js; ~1.5 ms localhost round‑trip; reconnect is free because **tmux owns screen state**. Design guidance we adopt: **one interactive attach per worker** owning the size; `status off` on bridge sessions (row‑math exactness); **secondary viewers get a read‑only `capture-pane`/`pipe-pane` mirror**, not a second full attach (sidesteps tmux's single‑grid size fight, spike §3); single‑attach model covers 100% of today's single‑pane workers.

**The one real productionization risk = `node-pty` native packaging** (spike blocker #1): a fresh install left `spawn-helper` as `0644`, breaking every spawn with an opaque `posix_spawnp failed`. Mitigation, baked into M2/M4: preserve/restore the execute bit through `asarUnpack` + a `postinstall` (`scripts/ensure-pty-helper.js` already exists as the reference fix), ship correct `darwin-arm64` / `darwin-x64` / `linux-*` prebuilds, and **CI smoke on a clean box per platform**. Output coalescing/backpressure on a microtask/animation frame caps chatty‑TUI flooding.

### The A→B migration path — what changes vs what stays

| Concern | Fork A (now) | Fork B (`hydrad`) | Verdict |
|---|---|---|---|
| `src/core` engine (SessionManager, tmux backend, git/worktree, agentRegistry) | in‑proc in sidecar | in‑proc in daemon | **UNCHANGED** |
| `~/.hydra/*.json` + `events.jsonl` + tmux + worktrees | source of truth | source of truth | **UNCHANGED** |
| Terminal bridge (node-pty + `tmux attach` + xterm.js) | sidecar WS | daemon WS | **UNCHANGED** (spike‑proven) |
| `HydraService` interface & CLI JSON contract | in‑proc calls | REST+WS serving same JSON | **UNCHANGED** |
| `EventBus` + `seq` cursors | in‑proc + 1 file‑tailer | WS fan‑out, single writer | **same bus, fewer sources** |
| Auth middleware shape (`Bearer` + origin) | launch token, loopback | issued/rotated tokens, TLS | **hardened, not rewritten** |
| React UI / xterm.js / diff / inbox | loopback client | remote client | **UNCHANGED** (same `HydraService`) |
| **Transport impl** | `LocalHydraService` (in‑proc) | `RemoteHydraService` (HTTP) | **SWAP one injected object** |
| **Process lifecycle** | sidecar `utilityProcess`, dies with app | `hydrad` under launchd/systemd, outlives clients, multi‑client | **new: daemon supervision** |
| **CLI wiring** | constructs engine in‑proc | hits daemon API (in‑proc fallback) | **new: one client shim** |
| **Writers of `events.jsonl`** | app + CLI + hooks (multi‑writer) | daemon only (CLI/hooks proxy) | **new: single‑writer** |

The seam is clean because **the four heaviest assets — engine, state, terminal, contract — are in the "UNCHANGED" column.** Fork B is "add a transport + auth + a daemon supervisor," never a rewrite. (Note: `hydra share` — GCS session‑bundle export/import, `src/cli/commands/share.ts` — is today's *manual, async* precursor to remote/multi‑device; Fork B generalizes it into live remote attach.)

### Security posture

Localhost‑only now, auth‑ready by construction: `127.0.0.1` bind + random port + per‑launch bearer + `Origin` check + payload redaction already enforced in the event log (`SENSITIVE_KEY_PATTERN`, `events.ts:52`). No secret is ever surfaced to the renderer beyond the launch token. Fork B flips loopback→TLS and launch‑token→issued‑token in the one middleware that already exists.

### Rough milestones & effort

| M | Scope | Est. |
|---|---|---|
| **M0** | Electron shell; engine in `utilityProcess`; loopback server; define `HydraService` + `LocalHydraService`; launch‑token auth | 1.5–2 wk |
| **M1** | Mission Control grid wired to `list`/create/stop/delete/send; **EventBus** (instant updates, no poll) | 2 wk |
| **M2** | Terminal bridge productionized (node-pty packaging, `status off`, resize, reconnect, coalescing) — per spike's own ~1–1.5 wk | 1.5 wk |
| **M3** | Attention Inbox + runtime‑state surfacing + read‑only Diff Review + ship flow | 2 wk |
| **M4** | Packaging/sign/notarize, cross‑platform prebuilds, clean‑box CI smoke, auto‑update | 1.5–2 wk |
| | **MVP total** | **~8.5–10 eng‑wk** |
| **B** | Graduate to `hydrad`: `RemoteHydraService` + REST/WS server + real auth/pairing + daemon supervision + CLI client shim | **~3–4 wk** (small *because* the seam is pre‑built) |

---

## 3. 主要风险与取舍 (Risks & trade-offs)

**Top risks & how to retire them:**

1. **node-pty native packaging (highest).** Breaks silently across bundlers/platforms (spike blocker #1). *Retire:* fix in M2, don't defer — `asarUnpack` + execute‑bit `postinstall` + prebuilds for `darwin-arm64/x64`, `linux-*`, and a **per‑platform clean‑box CI smoke** that spawns one PTY. The spike already found and fixed the failure mode, so this is de‑risked, not unknown.
2. **Multi‑writer coordination in Fork A.** A long‑lived sidecar now races the CLI + agent hooks on `~/.hydra` and `events.jsonl`. *Retire:* keep files authoritative, EventBus advisory; reuse the existing `withLock` + atomic temp‑rename + `seq` cursors; the single file‑tailer replays from cursor so a missed external write is never lost. (Concrete pitfall to test: sidecar EventBus emits an event the file‑tailer *also* re‑delivers → dedupe by `seq`.)
3. **tmux single‑grid sizing** if a human `tmux attach`es a worker the app is already viewing (spike §3). *Retire:* secondary viewers are read‑only mirrors (`capture-pane`/`pipe-pane`); the app owns the size for the one interactive attach.
4. **Windows.** tmux is macOS/Linux (AGENTS.md prereqs); the runtime *is* tmux. *Retire/scope:* v1 targets macOS + Linux; Windows via WSL or a later multiplexer backend (the `MultiplexerBackendCore` interface already makes an alternative backend a drop‑in — but that's a separate bet).
5. **Electron footprint/RAM.** Accepted; reversible since the shell is Fork‑A‑only (§1).

**The 2–3 decisions I'm least sure about:**

1. **Electron vs Tauri.** I chose Electron on Node‑reuse + team + node-pty maturity; the strongest opposing case is footprint + the *philosophical* pull that Tauri **forces** a process boundary on day one (you can't "cheat" with in‑proc calls, so the B‑seam is unavoidable). I counter that the discipline of the injected `HydraService` + a loopback‑first renderer gives the same guarantee *without* paying for a second runtime and language at MVP. Reasonable people will disagree; it's the most debatable call and the most reversible.
2. **`import core` vs `spawn CLI`.** I chose `import` (speed, streaming, types). The legitimate opposing case: spawning the CLI reuses the *entire* battle‑tested, smoke‑covered contract with **zero new interface surface**, which is tempting for a fast MVP. I reject it for the data plane (latency, no push) but concede it's the lowest‑risk path for rarely‑used verbs (`repo`, `config`, `share`) — those could shell out in v1 without harm.
3. **How aggressively to drop `fs.watchFile` in Fork A.** The EventBus + single‑file‑tailer hybrid is the subtle part; get the dedupe/cursor logic wrong and you either double‑fire UI updates or miss external writes. I'm confident in the *shape* (chokepoint at `EventLog.append`) but the multi‑process edge cases need a dedicated test matrix before I'd call it retired.

---

## Executive recommendation

Build the Hydra desktop app as an **Electron** cockpit whose renderer is a **thin loopback client from day one**, backed by a **Node sidecar that `import`s the already‑headless `src/core` in‑process** and exposes a single injected `HydraService` interface whose verbs and JSON mirror the existing, contract‑tested CLI (`docs/cli-contract.md`). Replace `fs.watchFile` polling with an in‑proc `EventBus` fed by the existing `EventLog.append()` chokepoint (keeping one file‑tailer for out‑of‑band CLI/hook writers), and reuse the spike's `node-pty`+`tmux attach` terminal bridge verbatim. This lands a real single‑machine product in **~8.5–10 engineer‑weeks** while making the graduation to Fork B a **~3–4 week "swap the transport + add auth + supervise a daemon"** exercise — because the engine, `~/.hydra` state, terminal bridge, and service contract all sit in the *unchanged* column of the migration table. The one thing to fund early and refuse to defer is **node-pty native packaging with clean‑box CI**; everything else is additive and reversible.
