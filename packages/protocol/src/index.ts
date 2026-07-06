// Public entry for @hydra/protocol — the engine-free control-plane seam.
//
// Consumers import the whole domain surface from `@hydra/protocol`:
//   • HydraControlClient / createHydraControlClient — the domain client
//   • HydraTransport / HydraAppService / transportFactory — the swappable waist
//   • InProcessTransport — the in-process transport (tests + single-process dev)
//   • all DTOs, op/topic names, and shared types
//
// NOTHING here imports Electron / http / ws / engine internals; every
// @hydra/core reference is `import type` and fully erased at runtime.

export * from './ops';
export * from './types';
export * from './dto';
export * from './transport';
export * from './inProcessTransport';
export * from './client';
