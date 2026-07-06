// The loopback wire vocabulary — the single source of truth for the HTTP/WS
// surface that `LoopbackHttpWsTransport` (client) and `createLoopbackServer`
// (server, in @hydra/sidecar) speak. Mirrors the role `ops.ts` plays in
// @hydra/protocol: it fixes the route paths, query-param names, auth scheme,
// and envelope shapes in ONE place so the two sides can never drift.
//
// This lives in @hydra/transport-loopback (not @hydra/protocol) on purpose:
// route strings are loopback-transport-specific (a future Fork-B RestWsTransport
// picks its own), so they must not leak into the transport-agnostic seam.
// @hydra/sidecar imports the constants from `@hydra/transport-loopback/wire` —
// a lightweight, engine-free edge that pulls in NO client runtime.
//
// It contains only string constants and interfaces (plus one type-only import
// of `TerminalMode`) — zero http/ws/engine imports — so both this package and
// @hydra/protocol stay free of transport *code*.

import type { TerminalMode } from '@hydra/protocol';

/** Route paths, all namespaced under `/v1`. */
export const LOOPBACK_ROUTES = {
  /** GET — liveness probe (authenticated; returns `{ status: 'ok' }`). */
  health: '/v1/health',
  /** POST — the control-plane `request` op, body `{ op, payload }`. */
  rpc: '/v1/rpc',
  /** WS upgrade — the `stream` subscription (`?topic=&payload=&token=`). */
  stream: '/v1/stream',
  /** WS upgrade — the terminal attach (`?session=&mode=&cols=&rows=&token=`). */
  terminal: '/v1/terminal',
} as const;

/** Query-param names used on the stream + terminal handshake URLs. */
export const WIRE_PARAMS = {
  topic: 'topic',
  /** URL-encoded JSON of the stream payload (e.g. `{ after }`). */
  payload: 'payload',
  /**
   * Bearer token, carried in the WS handshake URL because the browser
   * `WebSocket` API cannot set an `Authorization` header. Loopback-only + a
   * per-launch token make a query-string token acceptable here (FINAL §Security).
   */
  token: 'token',
  // ── terminal handshake (/v1/terminal) ──
  /** Target tmux session name to attach. */
  session: 'session',
  /** `interactive` (owns the tmux grid) or `mirror` (read-only observer). */
  mode: 'mode',
  /** Initial terminal width, in columns. */
  cols: 'cols',
  /** Initial terminal height, in rows. */
  rows: 'rows',
} as const;

/** HTTP `Authorization` scheme. */
export const BEARER_PREFIX = 'Bearer ';

/** Marker on the sidecar's stdout ready line, parsed by the parent process. */
export const SIDECAR_READY_TYPE = 'hydra-sidecar-ready';

/** The single JSON line `node main.js` prints to stdout once bound. */
export interface SidecarReadyLine {
  type: typeof SIDECAR_READY_TYPE;
  url: string;
  port: number;
}

/** POST /v1/rpc request body — the `transport.request(op, payload)` envelope. */
export interface RpcRequestBody {
  op: string;
  payload?: unknown;
}

/** POST /v1/rpc success body (HTTP 200). */
export interface RpcSuccessBody<T = unknown> {
  result: T;
}

/** Error body for any non-2xx response (auth, bad origin, dispatch throw). */
export interface RpcErrorBody {
  error: { message: string };
}

/**
 * A single frame on the `/v1/stream` WebSocket. Exactly one field is set:
 *   • `event` — the next streamed value (JSON of a HydraEvent / snapshot)
 *   • `error` — the server-side iterable threw; the client stream rejects
 *   • `done`  — the server-side iterable completed; the client stream ends
 */
export interface StreamFrame<T = unknown> {
  event?: T;
  error?: { message: string };
  done?: true;
}

// ── terminal wire (/v1/terminal) ──────────────────────────────────────────
//
// The framing is role-asymmetric AND channel-typed so control and data can
// never collide (the spike's leading-`{` heuristic is replaced by real frame
// typing):
//   • client → server : JSON **text** frames — `TerminalClientFrame`
//     (input keystrokes + resize).
//   • server → client : raw PTY output as **binary** frames (UTF-8 bytes, fed
//     straight to xterm), plus one-line JSON **text** control frames
//     (`TerminalControlFrame`: hello / exit / error). A text frame is always
//     control; a binary frame is always terminal output.

/** Client → server terminal frames (JSON text). */
export type TerminalClientFrame =
  /** Keystrokes typed into the interactive owner (ignored for mirrors). */
  | { t: 'i'; d: string }
  /** Resize request: `c` columns × `r` rows. */
  | { t: 'r'; c: number; r: number };

/** Server → client terminal control frames (JSON text). */
export type TerminalControlFrame =
  /** Sent once on attach, after the PTY (or mirror) is live. */
  | { t: 'hello'; session: string; mode: TerminalMode; cols: number; rows: number }
  /** The PTY exited / the session ended — a *clean* end (do not reconnect). */
  | { t: 'exit'; code: number | null; signal?: number | null }
  /** A hard error (bad session, spawn failure) — the socket then closes. */
  | { t: 'error'; message: string };
