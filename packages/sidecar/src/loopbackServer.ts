// createLoopbackServer — the M1 HTTP/WS front for `HydraAppService`.
//
// Binds an HTTP+WS server to 127.0.0.1 on a random port and maps the loopback
// wire (routes/params from `@hydra/transport-loopback/wire`) straight onto the
// existing `HydraAppService` — the SAME server-side handler M0 proved in-proc.
// Fork B swaps the transport in front of this class, never the class itself.
//
//   POST /v1/rpc          → appService.request(op, payload)   (control plane)
//   WS   /v1/stream       → appService.stream(topic, payload) (events / notifs)
//   WS   /v1/terminal     → TerminalBridge (node-pty ⇄ tmux attach)   (M3)
//   GET  /v1/health       → { status: 'ok' }                  (liveness)
//
// Security posture (FINAL §Security), enforced from day one:
//   • bind 127.0.0.1 only — never a LAN interface, no LAN-listen flag
//   • every request/socket needs `Authorization: Bearer <token>` (or, for the
//     header-less browser WS handshake, `?token=`), compared in constant time
//   • non-local `Origin` is rejected (403) — blocks a web page from driving the
//     loopback server via the user's browser

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

import type {
  AuthContext,
  HydraAppService as HydraAppServiceApi,
  TerminalAttachInput,
} from '@hydra/protocol';
import {
  BEARER_PREFIX,
  LOOPBACK_ROUTES,
  WIRE_PARAMS,
  type RpcRequestBody,
  type StreamFrame,
} from '@hydra/transport-loopback/wire';

import { TerminalBridge } from './terminalBridge';

const DEFAULT_HOST = '127.0.0.1';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;

// A unique sentinel so a stream frame value can never collide with "closed".
const CLOSED = Symbol('socket-closed');

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

export interface LoopbackServerOptions {
  /** Per-launch bearer token every request/socket must present. Required. */
  token: string;
  /** Bind host. Defaults to 127.0.0.1 — do NOT point this at a LAN interface. */
  host?: string;
  /** Bind port. Defaults to 0 (an OS-assigned random port). */
  port?: number;
}

export interface LoopbackServer {
  /** Base URL, e.g. `http://127.0.0.1:53211`. */
  url: string;
  port: number;
  /** Stop accepting connections, drop live sockets, and free the port. */
  close(): Promise<void>;
}

interface TerminalAuthorizingAppService extends HydraAppServiceApi {
  authorizeTerminal(input: TerminalAttachInput): Promise<void>;
  dispose?(): void;
}

/** Denial verdict from the auth/origin gate, or `null` when the request passes. */
interface Denial {
  status: number;
  message: string;
}

/**
 * Boot a loopback HTTP/WS server in front of `appService`. Resolves once bound,
 * with the chosen `{ url, port, close() }`.
 */
export function createLoopbackServer(
  appService: TerminalAuthorizingAppService,
  options: LoopbackServerOptions,
): Promise<LoopbackServer> {
  const token = options.token;
  if (!token) {
    throw new Error('createLoopbackServer: a token is required (auth is mandatory)');
  }
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? 0;

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: { message: errorMessage(error) } });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  // One bridge per server owns the interactive-owner registry (one owner per
  // worker); each `/v1/terminal` socket is handed to `bridge.handle`.
  const terminalBridge = new TerminalBridge(async (session) => {
    await appService.authorizeTerminal({ session });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req);
    if (url.pathname !== LOOPBACK_ROUTES.stream && url.pathname !== LOOPBACK_ROUTES.terminal) {
      rejectUpgrade(socket, 404, `no ws route for ${url.pathname}`);
      return;
    }
    // Auth (bearer token + local origin) runs BEFORE the upgrade completes, so
    // the high-privilege terminal endpoint is never unauthenticated (FINAL
    // §Security: "no unauthenticated terminal endpoint").
    const denial = authorize(req, url, token);
    if (denial) {
      rejectUpgrade(socket, denial.status, denial.message);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === LOOPBACK_ROUTES.terminal) {
        void terminalBridge.handle(ws, url);
      } else {
        void handleStream(ws, url);
      }
    });
  });

  // ── HTTP routing (every route is authed; auth runs before routing) ──

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = parseUrl(req);
    // CORS grant, scoped to local origins (so the Electron renderer, loaded from
    // file:// → Origin `null`, can fetch the loopback API cross-origin). Non-local
    // origins get no grant AND are rejected by `authorize` below.
    const cors = corsHeadersFor(headerValue(req, 'origin'));
    const respond = (status: number, body: unknown) => sendJson(res, status, body, cors);

    // CORS preflight is answered before auth — it never carries credentials.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const denial = authorize(req, url, token);
    if (denial) {
      respond(denial.status, { error: { message: denial.message } });
      return;
    }

    if (req.method === 'GET' && url.pathname === LOOPBACK_ROUTES.health) {
      respond(200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && url.pathname === LOOPBACK_ROUTES.rpc) {
      let body: RpcRequestBody;
      try {
        body = await readRpcBody(req);
      } catch (error) {
        respond(400, { error: { message: errorMessage(error) } });
        return;
      }
      try {
        const result = await appService.request(body.op, body.payload, { token } as AuthContext);
        respond(200, { result });
      } catch (error) {
        // A thrown handler (bad op, "Session not found", path-escape, …) maps to
        // 400 so the client transport rejects with the same message — parity
        // with the in-process transport, which rejects the promise as-is.
        respond(400, { error: { message: errorMessage(error) } });
      }
      return;
    }

    if (url.pathname === LOOPBACK_ROUTES.terminal) {
      // The terminal is a WebSocket endpoint; a plain HTTP hit is a client bug.
      respond(426, { error: { message: 'terminal requires a WebSocket upgrade' } });
      return;
    }

    respond(404, { error: { message: `no route for ${req.method ?? '?'} ${url.pathname}` } });
  }

  // ── WS stream: pump appService.stream() frames until either side stops ──

  async function handleStream(ws: WsWebSocket, url: URL): Promise<void> {
    const topic = url.searchParams.get(WIRE_PARAMS.topic) ?? '';
    const payloadRaw = url.searchParams.get(WIRE_PARAMS.payload);
    let payload: unknown;
    try {
      payload = payloadRaw ? JSON.parse(payloadRaw) : {};
    } catch {
      sendFrame(ws, { error: { message: 'stream: malformed payload' } });
      ws.close();
      return;
    }

    let iterator: AsyncIterator<unknown>;
    try {
      const iterable = appService.stream<unknown, unknown>(topic, payload, { token } as AuthContext);
      iterator = iterable[Symbol.asyncIterator]();
    } catch (error) {
      sendFrame(ws, { error: { message: errorMessage(error) } });
      ws.close();
      return;
    }

    // Race each pull against socket close so a hung poll (no events) still tears
    // down promptly: on close we break and call iterator.return(), which runs the
    // generator's finally (clearing the event poll timer / disposing the service).
    let clientClosed = false;
    const closedSignal = new Promise<typeof CLOSED>((resolve) => {
      const onClose = () => {
        clientClosed = true;
        resolve(CLOSED);
      };
      ws.once('close', onClose);
      ws.once('error', onClose);
    });

    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), closedSignal]);
        if (clientClosed || next === CLOSED) {
          break;
        }
        const result = next as IteratorResult<unknown>;
        if (result.done) {
          sendFrame(ws, { done: true });
          break;
        }
        if (ws.readyState !== ws.OPEN) {
          break;
        }
        sendFrame(ws, { event: result.value });
      }
    } catch (error) {
      if (!clientClosed && ws.readyState === ws.OPEN) {
        sendFrame(ws, { error: { message: errorMessage(error) } });
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {
        // Best-effort teardown.
      }
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    }
  }

  return new Promise<LoopbackServer>((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once('error', onListenError);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', onListenError);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      resolve({
        url: `http://${formatHost(host)}:${port}`,
        port,
        close: () => {
          appService.dispose?.();
          return new Promise<void>((resolveClose) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.close(() => resolveClose());
            // Drop lingering keep-alive HTTP connections so shutdown doesn't hang
            // on idle clients (and the server handle releases promptly).
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}

// ── auth / origin gate ──

function authorize(req: IncomingMessage, url: URL, expectedToken: string): Denial | null {
  const origin = headerValue(req, 'origin');
  if (!isLocalOrigin(origin)) {
    return { status: 403, message: 'forbidden: non-local origin' };
  }
  const provided = extractToken(req, url);
  if (!provided || !tokensMatch(provided, expectedToken)) {
    return { status: 401, message: 'unauthorized' };
  }
  return null;
}

function isLocalOrigin(origin: string | undefined): boolean {
  // Absent (a Node client / same-origin navigation) or `null` is allowed — the
  // bearer token is the real gate. Any concrete cross-origin host must be
  // loopback.
  if (!origin || origin === 'null') {
    return true;
  }
  try {
    const parsed = new URL(origin);
    // The Electron renderer loads from file://, and Chromium sends the WS
    // handshake with `Origin: file://` (empty host) — NOT the string `null` that
    // fetch sends. Allow any file: origin, else the terminal + event-stream
    // WebSockets get 403'd while RPC (Origin: null) slips through.
    if (parsed.protocol === 'file:') {
      return true;
    }
    return LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const header = headerValue(req, 'authorization');
  if (header && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length);
  }
  // The browser WebSocket API can't set headers, so the handshake carries the
  // token in the query string instead.
  return url.searchParams.get(WIRE_PARAMS.token) ?? undefined;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// ── HTTP helpers ──

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readRpcBody(req: IncomingMessage): Promise<RpcRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RPC_BODY_BYTES) {
        reject(new Error('rpc body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? (JSON.parse(text) as RpcRequestBody) : undefined;
        if (!parsed || typeof parsed.op !== 'string') {
          reject(new Error('invalid rpc body: expected { op, payload }'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`invalid rpc body: ${errorMessage(error)}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * CORS grant for a request's Origin — but ONLY for local origins. The Electron
 * renderer loads from `file://` (Origin `null`) and fetches the loopback API
 * cross-origin, so it needs a matching `Access-Control-Allow-Origin`. A present
 * but non-local Origin gets no grant (and is also rejected by `authorize`); an
 * absent Origin (a native client) needs no CORS at all.
 */
function corsHeadersFor(origin: string | undefined): Record<string, string> {
  if (!origin || !isLocalOrigin(origin)) {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = STATUS_TEXT[status] ?? 'Error';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message,
  );
  socket.destroy();
}

function sendFrame(ws: WsWebSocket, frame: StreamFrame): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exported so callers can `import type { Server }` if they need the raw node
// server for advanced wiring; not part of the public LoopbackServer shape.
export type { Server as NodeHttpServer };
