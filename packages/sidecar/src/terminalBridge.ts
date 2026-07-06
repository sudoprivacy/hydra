// TerminalBridge — the server side of the terminal seam (M3).
//
// Productionizes the validated spike (spikes/terminal-bridge): node-pty runs
// `tmux attach`, tmux owns the screen state, and each WebSocket carries one
// terminal. This module is the sidecar half; the client half is
// `LoopbackHttpWsTransport.openTerminal` (packages/transport-loopback). The
// loopback server (loopbackServer.ts) authorizes the `/v1/terminal` upgrade
// (bearer token + local origin) and hands the socket here.
//
// Two attach modes (FINAL §"Terminal integration", spike §3/§7):
//   • interactive — node-pty spawns `tmux attach-session -t <session>`. This is
//     the ONE owner of the session's size; a newer interactive client evicts the
//     previous one (newest wins), which keeps reconnect bulletproof and avoids
//     tmux's single-grid size fight. `status off` so row math is exact.
//   • mirror — a read-only observer. NO attach (so it never touches the grid or
//     size): poll `capture-pane -e` and repaint on change. Input is ignored.
//
// Wire framing (see @hydra/transport-loopback/wire): raw PTY output → binary
// frames; JSON control (hello/exit/error) → text frames. tmux repaints the
// whole pane on every (re)attach, so reconnect needs no server-side replay.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { spawn as spawnPty, type IDisposable, type IPty } from 'node-pty';
import type { RawData, WebSocket as WsWebSocket } from 'ws';

import { getTmuxSocketArgs } from '@hydra/core/path';
import { getTmuxSanitizedEnvKeys } from '@hydra/core/tmux';
import type { TerminalMode } from '@hydra/protocol';
import {
  WIRE_PARAMS,
  type TerminalClientFrame,
  type TerminalControlFrame,
} from '@hydra/transport-loopback/wire';

// Size clamps mirror the spike (guard against absurd dims from a hostile URL).
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;

// Output coalescing/backpressure tuning for chatty TUIs (FINDINGS §6).
const COALESCE_MS = 8; // batch PTY reads into ~1 frame per animation tick
const HIGH_WATER_BYTES = 1 << 20; // 1 MiB queued on the socket → pause the PTY
const LOW_WATER_BYTES = 1 << 18; // drained below 256 KiB → resume the PTY

// Read-only mirror repaint cadence.
const MIRROR_POLL_MS = 400;

/**
 * Owns per-session interactive attachment state for one loopback server. One
 * instance is created by `createLoopbackServer`; `handle` is called once per
 * `/v1/terminal` socket (already authorized).
 */
export class TerminalBridge {
  /** session → its current interactive owner socket (one owner per worker). */
  private readonly owners = new Map<string, WsWebSocket>();

  handle(ws: WsWebSocket, url: URL): void {
    const session = url.searchParams.get(WIRE_PARAMS.session);
    if (!session) {
      sendControl(ws, { t: 'error', message: 'terminal: session is required' });
      ws.close();
      return;
    }
    const mode: TerminalMode =
      url.searchParams.get(WIRE_PARAMS.mode) === 'mirror' ? 'mirror' : 'interactive';
    const cols = clampInt(url.searchParams.get(WIRE_PARAMS.cols), 80, MIN_COLS, MAX_COLS);
    const rows = clampInt(url.searchParams.get(WIRE_PARAMS.rows), 24, MIN_ROWS, MAX_ROWS);

    // Session-existence check before any attach (FINAL §Security). We ask tmux
    // directly (not SessionManager) so the bridge stays decoupled from the
    // engine and works against any tmux session the user can attach.
    if (!sessionExists(session)) {
      sendControl(ws, { t: 'error', message: `tmux session "${session}" not found` });
      ws.close();
      return;
    }

    if (mode === 'mirror') {
      startMirror(ws, session, cols, rows);
    } else {
      this.startInteractive(ws, session, cols, rows);
    }
  }

  private startInteractive(ws: WsWebSocket, session: string, cols: number, rows: number): void {
    // Enforce a single interactive owner: evict any prior one (newest wins).
    const previous = this.owners.get(session);
    if (previous && previous !== ws) {
      sendControl(previous, { t: 'error', message: 'replaced by a newer interactive client' });
      try {
        previous.close();
      } catch {
        // already closing — fine
      }
    }
    this.owners.set(session, ws);

    // `status off` so the browser's N rows map to N program rows (tmux's status
    // bar would otherwise eat one — FINDINGS §3).
    runTmux(['set-option', '-t', session, 'status', 'off']);

    let term: IPty;
    try {
      term = spawnPty(tmuxBinary(), [...tmuxBaseArgs(), 'attach-session', '-t', session], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME,
        env: buildPtyEnv(),
      });
    } catch (error) {
      // Most likely cause on macOS: node-pty's spawn-helper lost its execute bit
      // (scripts/ensure-pty-helper.js restores it). Report, don't crash.
      sendControl(ws, { t: 'error', message: `failed to spawn tmux PTY: ${errorMessage(error)}` });
      if (this.owners.get(session) === ws) {
        this.owners.delete(session);
      }
      ws.close();
      return;
    }

    sendControl(ws, { t: 'hello', session, mode: 'interactive', cols, rows });

    // ── output coalescing + backpressure ──
    let pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let paused = false;
    let disposed = false;

    const flush = (): void => {
      flushTimer = null;
      if (pending.length > 0 && ws.readyState === ws.OPEN) {
        const chunk = Buffer.from(pending.join(''), 'utf8');
        pending = [];
        ws.send(chunk);
      }
      // Never drop terminal bytes (that corrupts the screen); throttle the source
      // instead — pause the PTY while the socket's send queue is deep, resume
      // once it drains.
      if (ws.bufferedAmount >= HIGH_WATER_BYTES && !paused) {
        paused = true;
        term.pause();
      } else if (paused && ws.bufferedAmount <= LOW_WATER_BYTES) {
        paused = false;
        term.resume();
      }
      if (!disposed && (paused || pending.length > 0)) {
        schedule();
      }
    };
    const schedule = (): void => {
      if (!flushTimer) {
        flushTimer = setTimeout(flush, COALESCE_MS);
      }
    };

    const onData: IDisposable = term.onData((data) => {
      pending.push(data);
      schedule();
    });

    const cleanup = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      onData.dispose();
      onExit.dispose();
      try {
        term.kill();
      } catch {
        // already dead — fine
      }
      if (this.owners.get(session) === ws) {
        this.owners.delete(session);
      }
    };

    const onExit: IDisposable = term.onExit(({ exitCode, signal }) => {
      flush(); // deliver any tail before announcing the exit
      sendControl(ws, { t: 'exit', code: exitCode ?? 0, signal: signal ?? null });
      cleanup();
      try {
        ws.close();
      } catch {
        // already closing — fine
      }
    });

    ws.on('message', (raw: RawData) => {
      const frame = parseClientFrame(raw);
      if (!frame) {
        return;
      }
      if (frame.t === 'i') {
        term.write(frame.d);
      } else if (frame.t === 'r') {
        const c = clampInt(frame.c, cols, MIN_COLS, MAX_COLS);
        const r = clampInt(frame.r, rows, MIN_ROWS, MAX_ROWS);
        try {
          term.resize(c, r);
        } catch {
          // A resize can race the PTY exiting — safe to ignore.
        }
      }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
}

/**
 * Read-only mirror: poll the visible pane and repaint on change. It never
 * attaches, so a second viewer can't fight the interactive owner's grid/size
 * (FINDINGS §3). Input and resize frames are ignored.
 */
function startMirror(ws: WsWebSocket, session: string, cols: number, rows: number): void {
  sendControl(ws, { t: 'hello', session, mode: 'mirror', cols, rows });

  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    timer = null;
    if (stopped || ws.readyState !== ws.OPEN) {
      stop();
      return;
    }
    // `-e` keeps colors/attributes; no `-S` → just the visible pane.
    const captured = runTmux(['capture-pane', '-p', '-e', '-t', session]);
    if (captured.status !== 0) {
      // The session ended (or vanished) — a clean end for the observer.
      sendControl(ws, { t: 'exit', code: 0, signal: null });
      stop();
      try {
        ws.close();
      } catch {
        // already closing — fine
      }
      return;
    }
    const content = captured.stdout ?? '';
    if (content !== last) {
      last = content;
      // Clear + home, then the current pane. Crude vs a real attach, but it is
      // the read-only fallback the spike prescribes, and stays truly read-only.
      ws.send(Buffer.from(`\x1b[2J\x1b[H${content}`, 'utf8'));
    }
    timer = setTimeout(tick, MIRROR_POLL_MS);
  };

  ws.on('message', () => {
    // Mirror is read-only: input + resize carry no owner rights.
  });
  ws.on('close', stop);
  ws.on('error', stop);
  tick();
}

// ── tmux helpers (argv-based, so they bypass the shell that @hydra/core uses) ──

function tmuxBinary(): string {
  return process.platform === 'win32' ? 'psmux' : 'tmux';
}

/** Socket args (`-L`/`-S`) so we hit the SAME tmux server the engine uses. */
function tmuxBaseArgs(): string[] {
  return getTmuxSocketArgs();
}

function runTmux(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(tmuxBinary(), [...tmuxBaseArgs(), ...args], { encoding: 'utf8' });
}

function sessionExists(session: string): boolean {
  return runTmux(['has-session', '-t', session]).status === 0;
}

/** process.env minus the VSCODE_ / Electron keys that would poison the pane. */
function buildPtyEnv(): { [key: string]: string | undefined } {
  const strip = new Set(getTmuxSanitizedEnvKeys());
  const env: { [key: string]: string | undefined } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!strip.has(key)) {
      env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  return env;
}

// ── frame helpers ──

function sendControl(ws: WsWebSocket, frame: TerminalControlFrame): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

function parseClientFrame(raw: RawData): TerminalClientFrame | null {
  try {
    const message = JSON.parse(raw.toString()) as TerminalClientFrame;
    if (message && (message.t === 'i' || message.t === 'r')) {
      return message;
    }
  } catch {
    // malformed frame — ignore
  }
  return null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
