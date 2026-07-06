// esbuild bundles `.css` imports into out/renderer.css (index.html links it).
// This ambient declaration lets the renderer typecheck (tsc -p
// tsconfig.renderer.json) accept the side-effect CSS import for @xterm/xterm.
declare module '*.css';
