// LoopbackHttpWsTransport — the Fork-A client transport (renderer → sidecar).
//
// It implements the 3-method `HydraTransport` waist over a real 127.0.0.1
// HTTP/WS loopback:
//   • request      — POST /v1/rpc          (global `fetch`)
//   • stream       — WS  /v1/stream        (global `WebSocket`)
//   • openTerminal — WS  /v1/terminal      (global `WebSocket`, node-pty ⇄ tmux)
//
// It uses ONLY global `fetch` + `WebSocket`, both present in Node ≥ 22 and in
// the Electron/Chromium renderer, so the exact same class runs headless in the
// smoke and in the desktop app — with zero engine or Node-builtin imports. The
// bearer token + local-origin posture is enforced server-side; here we just
// carry the token (Authorization header for HTTP, `?token=` for the WS
// handshake, which cannot set headers in a browser).

import type { AuthContext, Disposable, TerminalAttachInput, TerminalChannel } from '@hydra/protocol';
import type { HydraTransport } from '@hydra/protocol';
import {
  BEARER_PREFIX,
  LOOPBACK_ROUTES,
  WIRE_PARAMS,
  type RpcRequestBody,
  type RpcErrorBody,
  type RpcSuccessBody,
  type StreamFrame,
  type TerminalClientFrame,
  type TerminalControlFrame,
} from './wire';

// Local readyState constants — portable across the browser `WebSocket` and
// Node's undici global (both follow the WHATWG numeric values).
const WS_OPEN = 1;
const WS_CLOSING = 2;

export interface LoopbackTransportOptions {
  /** Base URL of the sidecar, e.g. `http://127.0.0.1:53211`. */
  url: string;
  /** Per-launch bearer token minted by the parent process. */
  token: string;
}

export class LoopbackHttpWsTransport implements HydraTransport {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: LoopbackTransportOptions) {
    // Normalize away a trailing slash so `${base}${route}` is always clean.
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.token = options.token;
  }

  async request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes> {
    const body: RpcRequestBody = { op, payload };
    const response = await fetch(`${this.baseUrl}${LOOPBACK_ROUTES.rpc}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `${BEARER_PREFIX}${auth?.token ?? this.token}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as RpcSuccessBody<TRes> & RpcErrorBody) : undefined;

    if (!response.ok) {
      const message = parsed?.error?.message ?? `request "${op}" failed (HTTP ${response.status})`;
      throw new Error(message);
    }
    return parsed?.result as TRes;
  }

  stream<TReq, TEvt>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvt> {
    return this.openStream<TReq, TEvt>(topic, payload, auth?.token ?? this.token);
  }

  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel {
    // A duplex `TerminalChannel` over a `/v1/terminal` WebSocket. The sidecar
    // spawns node-pty ⇄ `tmux attach` on the other end (interactive owner) or a
    // read-only capture-pane mirror. Framing (see wire.ts): binary frames are
    // terminal output, text frames are JSON control.
    const token = input.auth?.token ?? auth?.token ?? this.token;
    return new LoopbackTerminalChannel(
      this.buildTerminalUrl(input, token),
      input.session,
      input.mode ?? 'interactive',
    );
  }

  // ── stream implementation ──

  private async *openStream<TReq, TEvt>(
    topic: string,
    payload: TReq,
    token: string,
  ): AsyncGenerator<TEvt> {
    const socket = new WebSocket(this.buildStreamUrl(topic, payload, token));

    const queue: TEvt[] = [];
    let streamError: Error | undefined;
    let done = false;
    let wake: (() => void) | undefined;
    const signal = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };

    // Attach the data listeners BEFORE awaiting open, so no early frame is lost.
    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let frame: StreamFrame<TEvt>;
      try {
        frame = JSON.parse(raw) as StreamFrame<TEvt>;
      } catch {
        streamError = new Error(`stream "${topic}": malformed frame`);
        done = true;
        signal();
        return;
      }
      if (frame.error) {
        streamError = new Error(frame.error.message);
        done = true;
      } else if (frame.done) {
        done = true;
      } else if ('event' in frame) {
        queue.push(frame.event as TEvt);
      }
      signal();
    });
    socket.addEventListener('close', () => {
      done = true;
      signal();
    });
    socket.addEventListener('error', () => {
      if (!done && !streamError) {
        streamError = new Error(`stream "${topic}": websocket error`);
      }
      done = true;
      signal();
    });

    await this.waitForOpen(socket, topic);

    try {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift() as TEvt;
        }
        if (streamError) {
          throw streamError;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      // Consumer stopped (break / return / throw): close the socket, which the
      // server observes and uses to tear down its underlying iterable (clearing
      // the event poll timer / disposing the notification service). readyState
      // < CLOSING covers CONNECTING (0) and OPEN (1).
      if (socket.readyState < WS_CLOSING) {
        socket.close();
      }
    }
  }

  private buildStreamUrl<TReq>(topic: string, payload: TReq, token: string): string {
    const url = new URL(`${this.baseUrl}${LOOPBACK_ROUTES.stream}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set(WIRE_PARAMS.topic, topic);
    url.searchParams.set(WIRE_PARAMS.payload, JSON.stringify(payload ?? {}));
    url.searchParams.set(WIRE_PARAMS.token, token);
    return url.toString();
  }

  private buildTerminalUrl(input: TerminalAttachInput, token: string): string {
    const url = new URL(`${this.baseUrl}${LOOPBACK_ROUTES.terminal}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set(WIRE_PARAMS.session, input.session);
    url.searchParams.set(WIRE_PARAMS.mode, input.mode ?? 'interactive');
    if (input.cols !== undefined) {
      url.searchParams.set(WIRE_PARAMS.cols, String(input.cols));
    }
    if (input.rows !== undefined) {
      url.searchParams.set(WIRE_PARAMS.rows, String(input.rows));
    }
    url.searchParams.set(WIRE_PARAMS.token, token);
    return url.toString();
  }

  private waitForOpen(socket: WebSocket, topic: string): Promise<void> {
    if (socket.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'close',
        () => reject(new Error(`stream "${topic}": connection closed before open`)),
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => reject(new Error(`stream "${topic}": connection failed`)),
        { once: true },
      );
    });
  }
}

/** Build a `HydraTransport` bound to a sidecar loopback URL + token. */
export function createLoopbackTransport(options: LoopbackTransportOptions): HydraTransport {
  return new LoopbackHttpWsTransport(options);
}

// ── terminal channel ──

/**
 * A `TerminalChannel` backed by one `/v1/terminal` WebSocket. It decodes the
 * wire framing (binary → output, text → control), buffers outbound frames until
 * the socket opens, and delivers a single `onExit`:
 *   • a numeric `code` — the server sent a clean `exit` control frame (the PTY /
 *     session genuinely ended; the caller should NOT reconnect).
 *   • `code === null` — the socket dropped with no `exit` frame (a transient
 *     network drop or error; the caller may reconnect with backoff).
 *
 * Reconnect itself is a caller concern (the renderer owns the backoff loop and
 * opens a fresh channel): tmux repaints the current screen on every reattach, so
 * a new channel is all that's needed — no client-side replay.
 */
class LoopbackTerminalChannel implements TerminalChannel {
  readonly session: string;
  readonly mode: TerminalChannel['mode'];

  private readonly socket: WebSocket;
  private readonly decoder = new TextDecoder();
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(info: { code: number | null }) => void>();
  /** Frames requested before the socket opened; flushed on 'open'. */
  private readonly outbound: TerminalClientFrame[] = [];
  /** Output that arrived before any onData listener registered. */
  private pendingData = '';
  /** Numeric code from a clean `exit` control frame, else null (transient). */
  private exitCode: number | null = null;
  private exited = false;
  private closedByCaller = false;

  constructor(url: string, session: string, mode: TerminalChannel['mode']) {
    this.session = session;
    this.mode = mode;

    const socket = new WebSocket(url);
    this.socket = socket;
    // Terminal output rides binary frames — take it as ArrayBuffer so we can
    // decode synchronously (a Blob would force an async read).
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      for (const frame of this.outbound.splice(0)) {
        socket.send(JSON.stringify(frame));
      }
    });
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.finish());
    socket.addEventListener('error', () => this.finish());
  }

  onData(listener: (chunk: string) => void): Disposable {
    this.dataListeners.add(listener);
    if (this.pendingData) {
      const buffered = this.pendingData;
      this.pendingData = '';
      listener(buffered);
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (info: { code: number | null }) => void): Disposable {
    if (this.exited) {
      listener({ code: this.exitCode });
      return { dispose: () => undefined };
    }
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.send({ t: 'i', d: data });
  }

  resize(cols: number, rows: number): void {
    this.send({ t: 'r', c: cols, r: rows });
  }

  close(): void {
    this.closedByCaller = true;
    if (this.socket.readyState < WS_CLOSING) {
      this.socket.close();
    }
  }

  private send(frame: TerminalClientFrame): void {
    if (this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(frame));
    } else if (!this.closedByCaller && this.socket.readyState < WS_CLOSING) {
      // Not open yet (still CONNECTING): queue and flush on 'open'.
      this.outbound.push(frame);
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.onControl(data);
      return;
    }
    // Binary frame → terminal output. `data` is an ArrayBuffer (binaryType).
    if (!(data instanceof ArrayBuffer)) {
      return;
    }
    // stream:true so a multibyte char split across frames still decodes cleanly.
    const text = this.decoder.decode(new Uint8Array(data), { stream: true });
    if (text) {
      this.emitData(text);
    }
  }

  private onControl(raw: string): void {
    let frame: TerminalControlFrame;
    try {
      frame = JSON.parse(raw) as TerminalControlFrame;
    } catch {
      return; // ignore malformed control frames
    }
    if (frame.t === 'exit') {
      // A clean end — remember the code so the eventual 'close' reports it as a
      // real exit (not a transient drop).
      this.exitCode = frame.code ?? 0;
    } else if (frame.t === 'error') {
      // Surface the server's reason as terminal output; 'close' follows.
      this.emitData(`\r\n\x1b[31m[hydra] ${frame.message}\x1b[0m\r\n`);
    }
    // 'hello' is informational; the caller learns readiness from live output.
  }

  private emitData(chunk: string): void {
    if (this.dataListeners.size === 0) {
      this.pendingData += chunk;
      return;
    }
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  private finish(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of this.exitListeners) {
      listener({ code: this.exitCode });
    }
    this.exitListeners.clear();
  }
}
