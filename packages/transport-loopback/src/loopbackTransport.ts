// LoopbackHttpWsTransport — the Fork-A client transport (renderer → sidecar).
//
// It implements the 3-method `HydraTransport` waist over a real 127.0.0.1
// HTTP/WS loopback:
//   • request      — POST /v1/rpc          (global `fetch`)
//   • stream       — WS  /v1/stream        (global `WebSocket`)
//   • openTerminal — throws NotImplemented (node-pty bridge is M3)
//
// It uses ONLY global `fetch` + `WebSocket`, both present in Node ≥ 22 and in
// the Electron/Chromium renderer, so the exact same class runs headless in the
// smoke and in the desktop app — with zero engine or Node-builtin imports. The
// bearer token + local-origin posture is enforced server-side; here we just
// carry the token (Authorization header for HTTP, `?token=` for the WS
// handshake, which cannot set headers in a browser).

import type { AuthContext, TerminalAttachInput, TerminalChannel } from '@hydra/protocol';
import type { HydraTransport } from '@hydra/protocol';
import {
  BEARER_PREFIX,
  LOOPBACK_ROUTES,
  WIRE_PARAMS,
  type RpcRequestBody,
  type RpcErrorBody,
  type RpcSuccessBody,
  type StreamFrame,
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

/** Thrown by `openTerminal` until the node-pty ⇄ tmux bridge lands in M3. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplemented';
  }
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

  openTerminal(input: TerminalAttachInput): TerminalChannel {
    // Matches HydraAppService.openTerminal: the shape is fixed in @hydra/protocol
    // but the node-pty ⇄ tmux bridge is milestone M3. Throw synchronously so the
    // client never opens a socket it cannot use.
    throw new NotImplementedError(
      `attachTerminal (node-pty ⇄ tmux bridge) is implemented in milestone M3; requested session "${input.session}"`,
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
