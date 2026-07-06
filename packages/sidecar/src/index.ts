// Public entry for @hydra/sidecar — the server side of the seam.
//
// M0 exports the engine-backed request handler, `HydraAppService`. M1 adds the
// loopback HTTP/WS server (`node sidecar.js`) that fronts this same class; the
// handler itself does not change when that server — or the future `hydrad`
// daemon — is added.
export { HydraAppService, type HydraAppServiceOptions } from './appService';
