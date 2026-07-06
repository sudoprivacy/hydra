# Spike: tmux ↔ WebSocket ↔ xterm.js terminal bridge

A minimal, self-contained demo that drives a **real tmux session** from a browser
`xterm.js` terminal through a small Node WebSocket bridge. Type into the page and
see live output from an actual interactive tmux session — as if attached — with
working resize and reconnect.

This exists to de-risk the terminal layer of a possible standalone Hydra desktop
app. See [`FINDINGS.md`](./FINDINGS.md) for the payoff (what worked, what didn't,
and the recommendation).

```
  browser (xterm.js)  ──WebSocket──►  server.js  ──node-pty──►  `tmux attach ...`  ──►  tmux session
        ▲  keystrokes / resize                                                              │
        └───────────────────────────  raw PTY output  ◄─────────────────────────────────────┘
```

## Requirements

- Node ≥ 18 (tested on v22)
- `tmux` on `PATH` (tested on tmux 3.6a)
- macOS or Linux (uses a PTY + node-pty's `spawn-helper`)

## Run it (2 commands)

```bash
cd spikes/terminal-bridge
npm install          # installs deps; a postinstall step fixes node-pty's spawn-helper (see Troubleshooting)

# Create a throwaway target to attach to (do NOT point at a real worker for input tests):
tmux new-session -d -s spike-target 'bash --norc -i'      # or: vim -u NONE -N   /   top

npm start            # serves http://127.0.0.1:7071
```

Open **http://127.0.0.1:7071** in a browser. It auto-connects to `spike-target`.
Type — you're driving the tmux session. Try `top`, `vim`, or a bash REPL.

### Controls (top bar)

- **tmux session** — which session to attach to (default `spike-target`).
- **mode** — `grouped` (default) or `attach`. See FINDINGS for why grouped is the
  default and what it does / doesn't buy you.
- **read-only** — drop all keystrokes (server-side *and* `tmux attach -r`). Use this
  to safely observe a real worker without sending stray input.
- **Connect / Disconnect**, live **cols×rows**, and a connection **status** pill.

You can also deep-link: `http://127.0.0.1:7071/?session=<name>&mode=grouped&readonly=1`.

## Headless validation (no browser)

A smoke test drives the bridge exactly like the browser would and checks the four
hard problems (bidirectional I/O, resize, grouped-vs-shared sizing, reconnect) plus
cleanup:

```bash
tmux new-session -d -s spike-target 'bash --norc -i'   # if not already running
npm start &                                            # bridge on :7071
npm run smoke                                           # -> "7 passed, 0 failed"
```

## Point it at a REAL Hydra worker (read-only)

Get a live worker session name from `hydra list --json` (`.workers[].session`), then
attach **read-only at the worker's current size** so you never resize/disrupt it:

```bash
W=$(hydra list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const w=JSON.parse(d).workers[0];console.log(w.session)})')
SIZE=$(tmux display -t "$W" -p '#{window_width}x#{window_height}')   # e.g. 80x24
open "http://127.0.0.1:7071/?session=$W&mode=grouped&readonly=1"
# then set the terminal to the worker's exact size before connecting, or just observe.
```

> ⚠️ tmux uses `window-size latest` by default, so an attaching client of a
> *different* size will resize the worker's window. For real workers, always attach
> **read-only at the worker's exact current size** (the read-only checkbox blocks
> input but not resize). The included real-worker probe does this automatically.

## Files

| File | What |
|------|------|
| `server.js` | HTTP static server + WebSocket bridge. Spawns one `tmux attach` PTY per client. |
| `public/index.html`, `public/client.js` | xterm.js client (vanilla, no framework). |
| `smoke-test.js` | Headless WS client that validates the four hard problems. `npm run smoke`. |
| `scripts/ensure-pty-helper.js` | postinstall fix for node-pty's `spawn-helper` execute bit. |
| `FINDINGS.md` | The real deliverable — analysis + recommendation. |

## Troubleshooting

**`Error: posix_spawnp failed.`** — node-pty's prebuilt `spawn-helper` binary lost
its execute bit during `npm install` (npm doesn't always preserve it on prebuilds).
The `postinstall` hook fixes this automatically; if you hit it anyway, run:

```bash
npm run postinstall        # chmod +x node_modules/node-pty/**/spawn-helper
```

**Port in use** — `PORT=8080 npm start`. **tmux not on PATH** — `TMUX_BIN=/path/to/tmux npm start`.

## Scope / non-goals

Localhost only, no auth, no TLS, no polish — this is a spike. It deliberately does
not touch the extension, `src/`, or the build.
