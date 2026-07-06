# FINDINGS — tmux ↔ WS ↔ xterm.js terminal bridge

**TL;DR:** `node-pty` running `tmux attach` piped over a WebSocket to `xterm.js`
**works, and is the right foundation** for the desktop app's terminal layer.
Bidirectional I/O, resize, and reconnect all work with imperceptible latency
(~1.5 ms round-trip on localhost). One real surprise (a node-pty packaging bug) and
one myth busted (the "grouped-session trick" does **not** give independent per-client
sizes). Neither is a blocker. Rough remaining effort to productionize: **~1–1.5 weeks**.

Environment: macOS (arm64), Node v22.22.2, node-pty 1.1.0, ws 8.x, @xterm/xterm 5.5,
tmux 3.6a with default `window-size latest`, `aggressive-resize off`.

All claims below are backed by the runnable `npm run smoke` (7/7 passing) plus the
real-worker and vim probes described in the README.

---

## 1. Which approach won, and why

Three candidates were on the table:

| Approach | Verdict |
|----------|---------|
| **PTY + `tmux attach`** (node-pty spawns `tmux attach-session`) | ✅ **Winner** |
| **Grouped session** (`tmux new-session -t target` then attach the throwaway) | ⚠️ Used as the default *packaging*, but does **not** deliver its headline benefit (see §3) |
| **`capture-pane` + `send-keys`** (poll screen text, inject keys) | ❌ Rejected for the interactive terminal |

**PTY + `tmux attach` won** because it gives full terminal fidelity for free: tmux
emits a real vt100/xterm stream (alternate screen, cursor addressing, colors,
mouse), so `xterm.js` renders it exactly like a native terminal. We confirmed this
end-to-end:

- **Interactive shell:** typed `echo <marker>` → the marker came back as both the
  keystroke echo *and* the command output (2× as expected).
- **Full-screen TUI:** launched `vim`, and the stream contained the alternate-screen
  switch (`ESC[?1049h`) and our typed text rendered inside vim's UI; `:q!` exited
  cleanly. Same for a real worker running `claude.exe` (§6).

**Why not `capture-pane` + `send-keys`?** That's the model Hydra's *current* VS Code
extension effectively uses for read-only logs (`hydra worker logs` = `capture-pane`).
It's fine for a passive log tail, but as an *interactive* terminal it's the wrong
tool: you'd be diffing plain-text screen snapshots on a poll interval (no true
streaming, visible latency/jank), you lose colors/styling/cursor unless you also
parse escape codes, key injection via `send-keys` is lossy for control sequences and
paste, and there's no natural resize path. `tmux attach` gives all of that natively.
Keep `capture-pane` only as a fallback for a lightweight read-only mirror (§4, §7).

The one non-obvious property that makes `attach` great: **tmux is the source of
truth for screen state.** The bridge is stateless plumbing — it holds no scrollback,
no cursor, no grid. That's what makes reconnect (§4) trivial.

---

## 2. Bidirectional I/O

Wire protocol is deliberately tiny and role-asymmetric (no framing ambiguity):

- **client → server:** JSON text frames — `{"t":"i","d":"<keystrokes>"}` (input) and
  `{"t":"r","c":<cols>,"r":<rows>}` (resize).
- **server → client:** raw PTY output as text frames (already UTF-8 decoded by
  node-pty's `StringDecoder`, so multibyte box-drawing chars survive chunk splits),
  plus a one-line `{"t":"hello"|"exit"|"error"}` control frame.

node-pty's `onData` → `ws.send`, and `ws` message → `pty.write`. That's the whole
hot path. Works flawlessly for shells and full-screen apps.

---

## 3. Resize — and the grouped-session trick (the myth-buster)

**Basic resize works perfectly.** `xterm` `fit` → send `cols/rows` over WS →
`pty.resize()` → tmux resizes the client → the window/pane resize → the program
(and `stty size` inside it) sees the new geometry. Measured: resizing one client
from 100→120 cols propagated all the way to the shell (`stty size` went 100→120).

One cosmetic detail: tmux's **status bar consumes 1 row**, so a client attached at
N rows gives the program N−1 rows (40→39, 50→49 in tests). Set `status off` (or
account for the −1) in production so the app's row math matches.

### Does the grouped-session trick give independent per-client sizes? **No.**

The spike asked us to evaluate `tmux new-session -t <target> -s <per-client>` so each
web client gets an independent window size. **It does not work for that purpose**,
and we proved it deterministically by asking tmux for each session's `window_width`
while three clients at three different sizes (120c, 111c, 66c) were attached:

```
spike-target:                    window_width=66
bridge_spike-target_..._6:       window_width=66
bridge_spike-target_..._7:       window_width=66
bridge_spike-target_..._8:       window_width=66
```

**All grouped sessions share tmux window @0, which has exactly one grid.** Grouped
sessions share the *window objects* (and their panes/contents), not just the window
list — so they cannot have independent sizes. With the default `window-size latest`,
that single shared grid simply snaps to whichever client was **last active**. Two
web clients at different sizes therefore *fight over one grid* (each keystroke/attach
yanks it to that client's size); the other client sees letterboxing or clipping. The
"decoupling" you might see in a quick test is just a timing snapshot of that fight,
not real independence.

The only ways to get genuinely independent sizes for the *same* running program are:
(a) accept a reconciliation policy (`window-size smallest` → everyone fits, smallest
wins; or `latest`); (b) give secondary viewers a **read-only mirror** via
`capture-pane`/`pipe-pane` (no size constraint, but no input); or (c) run a separate
program instance per viewer (not shared state). tmux fundamentally cannot show one
window at two sizes at once.

**Does this matter for Hydra? Mostly no.** The common case is **one interactive
viewer per worker** — the desktop app is the sole attacher and simply owns the
session size (set it to the browser terminal's size; it just works). Size coupling
only bites if a human's real `tmux attach` **and** the desktop app are live on the
same worker simultaneously at different sizes. For that case, make the secondary
viewer read-only (mirror) rather than trying to co-attach at full fidelity.

**So why keep `grouped` as the bridge default?** A small real benefit remains: the
throwaway per-client session gives the web client its **own status line and current-
window selection**, and tearing it down on disconnect never touches the target. But
for the single-viewer desktop case, **plain `tmux attach` (or `new-session -A`) is
simpler and equivalent** — the grouped wrapper is optional, not load-bearing.

---

## 4. Reconnect

**Works, and is essentially free** because tmux holds all state. Kill the tab / drop
the network → the WS closes, the per-client PTY dies, the client-side grouped session
is cleaned up — **the target session keeps running untouched**. On reconnect, a fresh
`tmux attach` **repaints the current screen** immediately (tmux redraws the full pane
on attach), so the terminal shows live current state with no client-side replay.

The client implements auto-reconnect with backoff (500 ms → 5 s). Validated: put a
line on screen, drop the socket, reconnect → the session persisted and the shell was
immediately responsive at the new size.

Caveat (acceptable): scrollback *above* the current screen is not restored on
reattach — tmux repaints the visible pane, not xterm's prior buffer. If you want
persistent scrollback across reconnects, either raise tmux's `history-limit` and
`capture-pane -p -S -` a backfill on connect, or keep a server-side ring buffer.
Not needed for a spike; a small nicety for production.

---

## 5. Multi-pane / multi-window analysis

Hydra workers today are **single-window, single-pane** (confirmed on the live
`wave3-prompt-registry` worker: 1 window, 1 pane, `claude.exe`). But the general
mapping is worth stating:

- **Multiple panes in one window:** *No extra work.* tmux composites all panes into
  the one attached window stream (it draws the pane borders itself). A single
  `tmux attach` → single WS → single xterm already renders a split-pane layout
  correctly, and `prefix` pane navigation/resize passes straight through as
  keystrokes. One WS per pane is **not** required for fidelity.
- **Multiple windows:** `attach` shows the **active** window; switching windows
  (`prefix n/p/<num>`) works through the bridge because keystrokes pass through. If
  the UI wants native window *tabs* instead of tmux's own, drive them out-of-band via
  `tmux list-windows` + `select-window` (control commands), not extra PTYs.
- **When would you want one WS/xterm per pane?** Only if the product wants to render
  panes as **separate, independently-laid-out UI surfaces** (e.g. a React grid) with
  independent sizing. That needs a per-pane feed — `pipe-pane` or `capture-pane` per
  `%pane_id`, plus `send-keys -t %pane` for input, plus `resize-pane`. That's a
  meaningfully bigger build (per-pane escape handling, focus routing) and is **not
  needed** unless/until the UX demands per-pane surfaces. Recommendation: ship the
  single-attach model first; it covers 100% of today's workers and most of tomorrow's.

---

## 6. Latency & jank

**Imperceptible.** Input→echo round-trip over WS+PTY+tmux on localhost (n=15):

```
min = 0.63 ms   median = 1.48 ms   max = 3.90 ms
```

No jank observed with `vim` (alternate screen) or a real `claude.exe` worker
streaming ANSI. For very chatty output (e.g. `yes`, a fast redrawing TUI), a spike
has no coalescing; production should batch PTY reads on a microtask/animation frame
and cap frame size to avoid flooding the socket — standard, low-risk.

Real-worker read-only observation (the `wave3-prompt-registry` worker) streamed
4757 bytes of correctly-rendered ANSI content, and the worker's size stayed **80×24
unchanged** during and after attach — **zero disruption**, and the throwaway grouped
session was cleaned up. This confirms the bridge works against Hydra's real session
naming (`<repo>-<hash>_<branch>`) and layout.

---

## 7. Recommendation

**Yes — `node-pty` + `tmux attach` is the right foundation for the desktop app's
terminal layer.** It's the highest-fidelity, lowest-state option; it reuses the
tmux runtime Hydra already depends on; and it makes reconnect trivial because tmux,
not the app, owns screen state. Ship it.

Design guidance that fell out of the spike:
- **One interactive attach per worker.** Let the app own the session size. Use plain
  `tmux attach` / `new-session -A`; the grouped wrapper is optional.
- **`status off`** on bridge-created sessions (or account for the −1 row) so geometry
  math is exact.
- **Secondary/observer viewers → read-only mirror** (`capture-pane`/`pipe-pane`),
  not a second full attach, to sidestep the single-grid size fight (§3).
- **Single-attach model** covers all of today's single-pane workers; defer per-pane
  surfaces until a UX actually needs them (§5).

### Blockers / surprises

1. **node-pty `spawn-helper` execute bit (SURPRISE, handled).** A fresh `npm install`
   left node-pty's prebuilt macOS `spawn-helper` as `0644`, so **every** PTY spawn
   failed with the opaque `Error: posix_spawnp failed.` Fixed here with a `postinstall`
   that `chmod +x`es it (`scripts/ensure-pty-helper.js`). **Implication for the desktop
   app:** whatever packages the native module (electron-builder / Tauri sidecar /
   asar) must preserve or restore that execute bit, and ship the correct
   `darwin-arm64` / `darwin-x64` / `linux-*` prebuild. This is the single most likely
   thing to break in packaging — bake it into the build and smoke-test on a clean box.
2. **tmux status bar eats a row** — cosmetic, set `status off`.
3. **Single-grid sizing** (§3) — a constraint to design around, not a bug.

No hard blockers.

### Fork A (sidecar) vs Fork B (daemon)

- **Fork A — bridge as a sidecar process** the desktop app spawns (no long-running
  daemon; stays file/JSONL-coordinated like today). *This spike **is** Fork A.* It
  drops in almost as-is: the app boots `server.js` (or embeds it), points xterm at
  `ws://127.0.0.1:<port>`, and one PTY is spawned per open terminal tab. Lifecycle is
  simple (sidecar dies with the app; tmux sessions persist regardless). **Only real
  concern: native-module packaging** (blocker #1) — the sidecar must ship a working
  node-pty for each target platform. Recommended path.
- **Fork B — a long-running daemon** owning coordination. Terminal layer is nearly
  identical (same node-pty + `tmux attach` core), with two upsides: (a) PTYs/attach
  clients outlive individual UI windows, so multiple UIs (web dashboard + desktop)
  can share one bridge, and (b) a natural home for the read-only mirror fan-out (§3/§5)
  and a server-side scrollback ring (§4). Costs: daemon lifecycle, auth, and port
  management. **The terminal code ports to Fork B unchanged** — nothing here bets
  against a daemon; it just doesn't require one.

Bottom line: the terminal layer is **fork-agnostic**. Build it as the sidecar (Fork A)
now; it lifts into a daemon (Fork B) later without a rewrite.

### Rough effort to productionize the terminal layer

Starting from this spike, **~1–1.5 engineer-weeks**:

| Work | Est. |
|------|------|
| Native-module packaging (node-pty prebuilds + execute-bit across mac/linux, in the app's bundler) & clean-box smoke test | 2–3 d |
| Output coalescing/backpressure + large-paste handling | 1 d |
| Session lifecycle & UX: pick worker from `hydra list`, `status off`, resize policy, robust reconnect/backfill scrollback | 1–2 d |
| Multi-window tabs via `list-windows`/`select-window` (control channel) | 1 d |
| Hardening: auth/origin checks even on localhost, error surfaces, teardown edge cases | 1 d |

Explicitly **out of scope** of that estimate (only if UX demands it): per-pane
independent UI surfaces (§5) — add ~3–5 d if pursued.
