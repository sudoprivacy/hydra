// The Fork-A "free" transport: dispatch request/stream/openTerminal straight to
// a `HydraAppService` living in the same process. No serialization, no socket —
// this is what proves the seam today (tests + single-process dev) and what a
// future LoopbackHttpWsTransport / RestWsTransport replace without any caller
// change.
//
// Imports from ./transport are TYPE-ONLY, so this module has no runtime edge
// back to transport.ts (which imports this class as a value). That keeps the
// factory ↔ transport wiring cycle-free.

import type { AuthContext, TerminalAttachInput, TerminalChannel } from './types';
import type { HydraAppService, HydraTransport } from './transport';

export class InProcessTransport implements HydraTransport {
  constructor(private readonly appService: HydraAppService) {}

  request<TReq, TRes>(op: string, payload: TReq, auth?: AuthContext): Promise<TRes> {
    return this.appService.request<TReq, TRes>(op, payload, auth);
  }

  stream<TReq, TEvt>(topic: string, payload: TReq, auth?: AuthContext): AsyncIterable<TEvt> {
    return this.appService.stream<TReq, TEvt>(topic, payload, auth);
  }

  openTerminal(input: TerminalAttachInput, auth?: AuthContext): TerminalChannel {
    return this.appService.openTerminal(input, auth);
  }
}
