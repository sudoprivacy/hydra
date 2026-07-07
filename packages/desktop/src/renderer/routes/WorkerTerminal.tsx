// WorkerTerminal — the M3 terminal view, now addressed by a `session` prop.
//
// A full-fidelity xterm.js terminal attached to the worker's tmux session over
// the loopback seam: `client.attachTerminal(...)` returns a TerminalChannel
// (node-pty ⇄ `tmux attach` on the sidecar). We forward keystrokes, refit on
// resize (→ pty.resize), and auto-reconnect with backoff on a transient drop —
// tmux repaints the current screen on every reattach, so no client-side replay.
//
// The tab shell keeps this component MOUNTED while its pane is hidden (keep-alive
// — the WebSocket stays live and scrollback is preserved). xterm cannot measure
// itself while `display:none`, so the pane passes `active` and we refit + refocus
// whenever this pane becomes the visible one again.

import { useEffect, useRef, useState } from 'react';

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

import type { Disposable, TerminalChannel } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';

type ConnectionStatus = 'connecting' | 'connected' | 'exited';

// Reconnect backoff, matching the spike client (500 ms → 5 s).
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
const RETRY_FACTOR = 1.6;

export interface WorkerTerminalProps {
  session: string;
  /** True when this pane is the visible tab; drives the show-again refit. */
  active?: boolean;
}

export function WorkerTerminal({ session, active = true }: WorkerTerminalProps): JSX.Element {
  const client = useHydraClient();
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Set by the mount effect; lets the `active` effect refit without re-attaching.
  const refitRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!session || !surface) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      // Latin from Menlo; CJK (and other non-Latin) fall back to the system
      // fonts that actually have the glyphs — else Chinese/Japanese/Korean text
      // renders blank in the Latin-only monospace fonts.
      fontFamily:
        'Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Courier New", monospace',
      fontSize: 13,
      scrollback: 5000,
      // macOS option-as-meta so alt-keybindings reach tmux/vim.
      macOptionIsMeta: true,
      // Required to activate the Unicode 11 width provider below.
      allowProposedApi: true,
      theme: { background: '#1e1e1e' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Use modern (Unicode 11) character widths — the same fix VS Code's terminal
    // applies — so Claude Code's box-drawing / symbol TUI (─ ⏺ ⎿ ✻ …) lines up
    // instead of smearing. The raw stream is correct; only xterm's default
    // Unicode-6 width table was misjudging these glyphs.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(surface);
    safeFit();

    let channel: TerminalChannel | null = null;
    let dataSub: Disposable | null = null;
    let exitSub: Disposable | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = INITIAL_RETRY_MS;
    let disposed = false;

    function safeFit(): void {
      try {
        fitAddon.fit();
      } catch {
        // The surface can be momentarily 0-sized during layout — ignore.
      }
    }

    // Expose refit+focus so the pane can call it when it becomes visible again
    // (xterm measures nothing while its container is display:none).
    refitRef.current = () => {
      safeFit();
      term.focus();
    };

    // Keystrokes + local resize flow to whatever channel is currently live.
    const inputSub = term.onData((data) => channel?.write(data));
    const resizeSub = term.onResize(({ cols, rows }) => channel?.resize(cols, rows));

    const connect = (): void => {
      if (disposed) {
        return;
      }
      setStatus('connecting');
      let live = false;
      const ch = client.attachTerminal({
        session,
        mode: 'interactive',
        cols: term.cols,
        rows: term.rows,
      });
      channel = ch;

      dataSub = ch.onData((chunk) => {
        if (!live) {
          // First byte back means we're really attached: mark connected and
          // reset the backoff for the next drop.
          live = true;
          retryMs = INITIAL_RETRY_MS;
          setStatus('connected');
        }
        term.write(chunk);
      });

      exitSub = ch.onExit(({ code }) => {
        dataSub?.dispose();
        exitSub?.dispose();
        dataSub = null;
        exitSub = null;
        channel = null;
        if (disposed) {
          return;
        }
        if (code === null) {
          // Transient drop (no clean exit frame) → reconnect with backoff.
          setStatus('connecting');
          reconnectTimer = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * RETRY_FACTOR, MAX_RETRY_MS);
        } else {
          // Clean PTY/session exit → stop and tell the user.
          setStatus('exited');
          term.writeln(`\r\n\x1b[90m[hydra] terminal exited (code ${code})\x1b[0m`);
        }
      });

      // Sync the sidecar PTY to our exact current geometry on every (re)attach.
      ch.resize(term.cols, term.rows);
      term.focus();
    };

    // Refit whenever the surface changes size (window resize, panel layout, …);
    // term.onResize then propagates the new geometry to the channel.
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(surface);

    connect();

    return () => {
      disposed = true;
      refitRef.current = () => {};
      observer.disconnect();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      inputSub.dispose();
      resizeSub.dispose();
      dataSub?.dispose();
      exitSub?.dispose();
      channel?.close();
      term.dispose();
    };
  }, [session, client]);

  // When this pane becomes the active tab, refit to its now-real size and focus.
  // A rAF lets the browser paint the un-hidden surface before we measure it.
  useEffect(() => {
    if (!active) {
      return;
    }
    const raf = requestAnimationFrame(() => refitRef.current());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <section className="hydra-terminal">
      <header className="hydra-terminal__header">
        <h1>Terminal</h1>
        <code className="hydra-terminal__session">{session || '(no session)'}</code>
        <span className={`hydra-terminal__status hydra-terminal__status--${status}`}>{status}</span>
      </header>
      <div ref={surfaceRef} className="hydra-terminal__surface" />
    </section>
  );
}
