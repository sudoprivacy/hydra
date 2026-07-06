// Public entry for @hydra/sidecar — the server side of the seam.
//
// M0 exports the engine-backed request handler, `HydraAppService`. M1 adds the
// loopback HTTP/WS server (`createLoopbackServer`, fronted by the `node main.js`
// entrypoint) that sits in front of this same class; the handler itself does not
// change when that server — or the future `hydrad` daemon — is added.
export { HydraAppService, type HydraAppServiceOptions } from './appService';
export {
  createLoopbackServer,
  type LoopbackServer,
  type LoopbackServerOptions,
} from './loopbackServer';
