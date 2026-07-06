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
// It contains only string constants and interfaces — zero http/ws/engine
// imports — so both this package and @hydra/protocol stay free of transport
// *code*.

/** Route paths, all namespaced under `/v1`. */
export const LOOPBACK_ROUTES = {
  /** GET — liveness probe (authenticated; returns `{ status: 'ok' }`). */
  health: '/v1/health',
  /** POST — the control-plane `request` op, body `{ op, payload }`. */
  rpc: '/v1/rpc',
  /** WS upgrade — the `stream` subscription (`?topic=&payload=&token=`). */
  stream: '/v1/stream',
  /** WS/GET — the terminal attach. M3 stub: responds 501. */
  terminal: '/v1/terminal',
} as const;

/** Query-param names used on the stream / (future) terminal handshake URLs. */
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
