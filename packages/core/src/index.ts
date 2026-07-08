// Public entry for @hydra/core.
//
// Consumers import specific modules via the `@hydra/core/<module>` subpath
// (e.g. `import { SessionManager } from '@hydra/core/sessionManager'`), which
// maps to `out/core/<module>.js` via the package `exports` map. This barrel
// re-exports the shared type surface for the bare `@hydra/core` specifier.
export * from './core/types';
