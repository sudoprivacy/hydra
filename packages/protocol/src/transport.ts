// THE CRUX — the swappable 3-method waist (FINAL.md §2).
//
// `HydraControlClient` (client.ts) is written ONCE against `HydraTransport`.
// Graduating Fork A → Fork B reimplements ONLY this interface:
//   • Fork A: InProcessTransport (this package) and, at M1, a
//     LoopbackHttpWsTransport (renderer → sidecar).
//   • Fork B: a RestWsTransport pointed at `hydrad`.
// UI callers and domain verbs never change — only the injected transport does.

import type { AuthContext, TerminalAttachInput, TerminalChannel } from './types';
import { InProcessTransport } from './inProcessTransport';

/**
 * The client-side waist. Three methods carry every domain call:
 *   • request  — request/response ops (create, delete, getDiff, …)
 *   • stream   — long-lived subscriptions (events, notifications)
 *   • openTerminal — the high-privilege terminal attach (its own method
 *     because it is neither request/response nor a plain event stream)
 */
export interface HydraTransport {
  request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes>;
  stream<TReq, TEvt>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvt>;
  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel;
}

/**
 * The server-side handler — the same 3-method shape, from the other side of the
 * waist. `HydraAppService` (packages/sidecar) implements this and is where the
 * in-proc `@hydra/core` calls live; it is *identical* in the future `hydrad`.
 * `InProcessTransport` forwards straight to an implementation of this
 * interface, which is why the seam works fully in-process today.
 *
 * Declared here (not in sidecar) so `InProcessTransport` can depend on the
 * contract without pulling engine code into this engine-free package.
 */
export interface HydraAppService {
  request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes>;
  stream<TReq, TEvt>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvt>;
  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel;
}

/**
 * DI selector, mirroring `createBackendFromConfig()` (the multiplexer backend
 * factory). Today only `in-process` exists; `loopback-http-ws` (M1) and
 * `rest-ws` (Fork B) slot in as new cases without touching any caller.
 */
export type TransportKind = 'in-process';

export interface InProcessTransportFactoryOptions {
  kind?: 'in-process';
  appService: HydraAppService;
}

export type TransportFactoryOptions = InProcessTransportFactoryOptions;

/**
 * Build a `HydraTransport` from config. The concrete `InProcessTransport` is
 * imported lazily via `import type` on the class only where needed, keeping the
 * factory the single place that knows which transport a `kind` maps to.
 */
export function transportFactory(options: TransportFactoryOptions): HydraTransport {
  const kind = options.kind ?? 'in-process';
  switch (kind) {
    case 'in-process': {
      if (!options.appService) {
        throw new Error('transportFactory: in-process transport requires an appService');
      }
      // No runtime cycle: inProcessTransport.ts imports only *types* from this
      // module, so its type-only edge back here is erased.
      return new InProcessTransport(options.appService);
    }
    default:
      throw new Error(`transportFactory: unsupported transport kind "${String(kind)}"`);
  }
}
