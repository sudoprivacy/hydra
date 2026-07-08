// Renderer entry — mounts the React app shell. esbuild bundles this to
// out/renderer.js (see scripts/build-frontend.mjs); index.html loads it.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('hydra-desktop: #root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
