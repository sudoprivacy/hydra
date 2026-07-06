// Public entry for @hydra/transport-loopback — the Fork-A client transport.
//
// A renderer (or the smoke) builds a `HydraControlClient` over loopback with the
// SAME calling code as the in-process path — only the injected transport differs:
//
//   in-process:  createHydraControlClient(transportFactory({ kind: 'in-process', appService }))
//   loopback:    createHydraControlClient(new LoopbackHttpWsTransport({ url, token }))
//
// The transport is the swappable waist; swapping it is the entire point of the
// seam (FINAL §"THE CRUX").
//
// Why the loopback DI selector lives HERE and not in @hydra/protocol: protocol
// must stay engine- and transport-free (only shared types). A `loopback-http-ws`
// case inside protocol's factory would force protocol to import a transport
// implementation, creating an import cycle and dragging transport code into the
// pure seam. Instead this package mirrors the factory pattern and delegates the
// `in-process` kind back to protocol — a clean superset layer.

import {
  createHydraControlClient,
  transportFactory as inProcessTransportFactory,
  type HydraControlClient,
  type HydraTransport,
  type AuthContext,
  type TransportFactoryOptions as InProcessTransportFactoryOptions,
} from '@hydra/protocol';
import {
  LoopbackHttpWsTransport,
  createLoopbackTransport,
  type LoopbackTransportOptions,
} from './loopbackTransport';

export * from './wire';
export {
  LoopbackHttpWsTransport,
  createLoopbackTransport,
  NotImplementedError,
  type LoopbackTransportOptions,
} from './loopbackTransport';

/** DI selector for the loopback transport. */
export interface LoopbackTransportFactoryOptions extends LoopbackTransportOptions {
  kind: 'loopback-http-ws';
}

/**
 * Superset of `@hydra/protocol`'s `transportFactory`: adds the
 * `loopback-http-ws` kind and delegates every other kind (today: `in-process`)
 * to protocol's factory. Consumers that need loopback import this one; the
 * options shape and return type are otherwise identical.
 */
export function transportFactory(
  options: LoopbackTransportFactoryOptions | InProcessTransportFactoryOptions,
): HydraTransport {
  if (options.kind === 'loopback-http-ws') {
    return new LoopbackHttpWsTransport(options);
  }
  return inProcessTransportFactory(options);
}

/**
 * Convenience: build a fully-wired `HydraControlClient` over loopback in one
 * call. Used by the desktop renderer and `smoke:loopback`.
 */
export function createLoopbackControlClient(
  options: LoopbackTransportOptions,
  auth?: AuthContext,
): HydraControlClient {
  return createHydraControlClient(createLoopbackTransport(options), auth);
}
