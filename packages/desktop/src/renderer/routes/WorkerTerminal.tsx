import { useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { Disposable, TerminalChannel } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import { useShellUi } from '../shell/shellState';

type ConnectionStatus =
  | 'inactive'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'exited'
  | 'replaced'
  | 'error';

interface TerminalController {
  readonly activate: () => void;
  readonly deactivate: () => void;
  readonly reconnect: () => void;
  readonly clearLocal: () => void;
}

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
const RETRY_FACTOR = 1.6;

export interface WorkerTerminalProps {
  session: string;
  /** Only the visible Terminal owns an interactive loopback/PTy channel. */
  active?: boolean;
}

export function WorkerTerminal({ session, active = true }: WorkerTerminalProps): JSX.Element {
  const client = useHydraClient();
  const shell = useShellUi();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const controllerRef = useRef<TerminalController>({
    activate: () => {},
    deactivate: () => {},
    reconnect: () => {},
    clearLocal: () => {},
  });
  const [status, setStatus] = useState<ConnectionStatus>(active ? 'connecting' : 'inactive');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!session || !surface) return;

    const openTerminalLink = (uri: string): void => {
      void window.hydra.openExternal(uri).catch(() => {});
    };
    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'Menlo, Monaco, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Courier New", monospace',
      fontSize: 13,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      linkHandler: { activate: (_event, uri) => openTerminalLink(uri) },
      theme: { background: '#171716' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(surface);

    let channel: TerminalChannel | null = null;
    let dataSub: Disposable | null = null;
    let exitSub: Disposable | null = null;
    let errorSub: Disposable | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fitFrame: number | null = null;
    let retryMs = INITIAL_RETRY_MS;
    let disposed = false;
    let hardError = false;
    let hasConnected = false;
    let lastResize = { cols: 0, rows: 0 };

    const safeFit = () => {
      if (!activeRef.current || disposed || surface.clientWidth === 0 || surface.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // Layout may still be settling; ResizeObserver will schedule another fit.
      }
    };

    const scheduleFit = () => {
      if (!activeRef.current || fitFrame !== null || disposed) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        safeFit();
      });
    };

    const disposeChannel = (close: boolean) => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      dataSub?.dispose();
      exitSub?.dispose();
      errorSub?.dispose();
      dataSub = null;
      exitSub = null;
      errorSub = null;
      const previous = channel;
      channel = null;
      if (close) previous?.close();
    };

    const scheduleReconnect = () => {
      if (!activeRef.current || disposed || hardError || reconnectTimer !== null) return;
      setStatus('reconnecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(true);
      }, retryMs);
      retryMs = Math.min(retryMs * RETRY_FACTOR, MAX_RETRY_MS);
    };

    const connect = (retrying = false): void => {
      if (!activeRef.current || disposed || channel) return;
      hardError = false;
      setDetail(null);
      setStatus(retrying || hasConnected ? 'reconnecting' : 'connecting');
      safeFit();
      let next: TerminalChannel;
      try {
        next = client.attachTerminal({
          session,
          mode: 'interactive',
          cols: term.cols,
          rows: term.rows,
        });
      } catch (cause) {
        hardError = true;
        setStatus('error');
        setDetail(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      channel = next;
      let live = false;
      dataSub = next.onData(chunk => {
        if (!live) {
          live = true;
          if (!hardError) {
            hasConnected = true;
            retryMs = INITIAL_RETRY_MS;
            setStatus('connected');
          }
        }
        term.write(chunk);
      });
      errorSub = next.onError(({ message }) => {
        hardError = true;
        setDetail(message);
        setStatus(message.toLowerCase().includes('replaced by a newer interactive client')
          ? 'replaced'
          : 'error');
      });
      exitSub = next.onExit(({ code }) => {
        if (next !== channel) return;
        disposeChannel(false);
        if (disposed || !activeRef.current) return;
        if (hardError) return;
        if (code === null) {
          scheduleReconnect();
        } else {
          setStatus('exited');
          setDetail(`Terminal exited with code ${code}.`);
          term.writeln(`\r\n\x1b[90m[hydra] terminal exited (code ${code})\x1b[0m`);
        }
      });
      lastResize = { cols: term.cols, rows: term.rows };
      next.resize(term.cols, term.rows);
    };

    const deactivate = () => {
      disposeChannel(true);
      setStatus('inactive');
      setDetail(null);
    };

    const activate = () => {
      if (disposed) return;
      // Passive effects run after the pane's hidden state has painted. Attach
      // immediately with the retained grid so background/occluded windows do
      // not stall on a throttled rAF; the single scheduled fit then reconciles
      // the visible geometry and emits a deduplicated resize if needed.
      connect();
      scheduleFit();
      term.focus();
    };

    const reconnect = () => {
      if (!activeRef.current || disposed) return;
      disposeChannel(true);
      hardError = false;
      retryMs = INITIAL_RETRY_MS;
      setDetail(null);
      connect(true);
    };

    const clearLocal = () => {
      term.clear();
      term.write('\x1b[2J\x1b[H');
      term.focus();
    };

    controllerRef.current = { activate, deactivate, reconnect, clearLocal };
    const inputSub = term.onData(data => channel?.write(data));
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (!channel || !activeRef.current || (lastResize.cols === cols && lastResize.rows === rows)) return;
      lastResize = { cols, rows };
      channel.resize(cols, rows);
    });
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(surface);
    scheduleFit();

    return () => {
      disposed = true;
      controllerRef.current = {
        activate: () => {},
        deactivate: () => {},
        reconnect: () => {},
        clearLocal: () => {},
      };
      observer.disconnect();
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      disposeChannel(true);
      inputSub.dispose();
      resizeSub.dispose();
      term.dispose();
    };
  }, [session, client]);

  useEffect(() => {
    if (active) controllerRef.current.activate();
    else controllerRef.current.deactivate();
  }, [active, session]);

  return (
    <section className="hydra-terminal">
      <header className="hydra-terminal__utility">
        <div className="hydra-terminal__connection" title={detail ?? statusLabel(status)}>
          <span className={`hydra-terminal__dot hydra-terminal__dot--${status}`} aria-hidden="true" />
          <span>{statusLabel(status)}</span>
        </div>
        <code className="hydra-terminal__session" title={session}>{session}</code>
        {detail ? <span className="hydra-terminal__detail" title={detail}>{detail}</span> : null}
        <div className="hydra-terminal__actions">
          <button type="button" onClick={() => controllerRef.current.reconnect()} disabled={!active}>
            Reconnect
          </button>
          <button type="button" onClick={() => controllerRef.current.clearLocal()}>
            Clear
          </button>
          <button type="button" onClick={shell.toggleTerminalMaximized}>
            {shell.terminalMaximized ? 'Restore' : 'Maximize'}
          </button>
        </div>
      </header>
      <div ref={surfaceRef} className="hydra-terminal__surface" />
    </section>
  );
}

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'inactive': return 'inactive';
    case 'connecting': return 'connecting';
    case 'connected': return 'connected';
    case 'reconnecting': return 'reconnecting';
    case 'exited': return 'exited';
    case 'replaced': return 'replaced';
    case 'error': return 'connection error';
  }
}
