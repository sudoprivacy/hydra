// Scoped styles for the diff review screen, injected as a single <style> tag.
//
// Kept inside the M4 lane (this dir) rather than the shared index.html so the
// parallel M2/M3 workers never collide with it. The CSP allows inline styles
// (`style-src 'unsafe-inline'`); every selector is prefixed `hydra-diff-` so it
// can't leak into the M2/M3 shells.

const DIFF_CSS = `
.hydra-diff {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 0.75rem;
}
.hydra-diff__header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}
.hydra-diff__title {
  margin: 0;
  font-size: 1.2rem;
}
.hydra-diff__meta {
  opacity: 0.75;
  font-size: 0.85rem;
}
.hydra-diff__meta code {
  font-size: 0.85em;
}
.hydra-diff__spacer {
  margin-left: auto;
}
.hydra-diff__toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.hydra-diff__button {
  font: inherit;
  font-size: 0.8rem;
  padding: 0.2rem 0.6rem;
  border: 1px solid rgba(128, 128, 128, 0.4);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.hydra-diff__button[aria-pressed='true'] {
  background: rgba(128, 128, 128, 0.2);
  font-weight: 600;
}
.hydra-diff__button:disabled {
  opacity: 0.5;
  cursor: default;
}
.hydra-diff__body {
  display: grid;
  grid-template-columns: minmax(200px, 300px) 1fr;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}
.hydra-diff__files {
  overflow: auto;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
}
.hydra-diff__file-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.hydra-diff__file {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  font: inherit;
  padding: 0.35rem 0.6rem;
  border: none;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.hydra-diff__file:hover {
  background: rgba(128, 128, 128, 0.12);
}
.hydra-diff__file[aria-selected='true'] {
  background: rgba(80, 140, 255, 0.18);
}
.hydra-diff__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-size: 0.85rem;
}
.hydra-diff__rename {
  opacity: 0.7;
  font-size: 0.75rem;
}
.hydra-diff__badge {
  flex: none;
  width: 1.15rem;
  height: 1.15rem;
  border-radius: 3px;
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.15rem;
  text-align: center;
  color: #fff;
}
.hydra-diff__badge--added { background: #2ea043; }
.hydra-diff__badge--modified { background: #9a6700; }
.hydra-diff__badge--deleted { background: #cf222e; }
.hydra-diff__badge--renamed { background: #6639ba; }
.hydra-diff__badge--copied { background: #0969da; }
.hydra-diff__badge--type-changed { background: #656d76; }
.hydra-diff__badge--unmerged { background: #cf222e; }
.hydra-diff__badge--unknown { background: #656d76; }
.hydra-diff__pane {
  overflow: auto;
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  min-height: 0;
}
.hydra-diff__filehead {
  position: sticky;
  top: 0;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: rgba(128, 128, 128, 0.12);
  border-bottom: 1px solid rgba(128, 128, 128, 0.25);
  font-size: 0.85rem;
  backdrop-filter: blur(2px);
}
.hydra-diff__stat-add { color: #2ea043; font-weight: 600; }
.hydra-diff__stat-del { color: #cf222e; font-weight: 600; }
.hydra-diff__code {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.8rem;
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.hydra-diff__code td {
  padding: 0 0.5rem;
  vertical-align: top;
  white-space: pre-wrap;
  word-break: break-word;
}
.hydra-diff__ln {
  width: 3rem;
  text-align: right;
  color: rgba(128, 128, 128, 0.8);
  user-select: none;
  background: rgba(128, 128, 128, 0.06);
  white-space: nowrap;
}
.hydra-diff__row--add td { background: rgba(46, 160, 67, 0.16); }
.hydra-diff__row--del td { background: rgba(207, 34, 46, 0.16); }
.hydra-diff__cell--empty { background: rgba(128, 128, 128, 0.05); }
.hydra-diff__sign {
  width: 1rem;
  text-align: center;
  color: rgba(128, 128, 128, 0.9);
  user-select: none;
}
.hydra-diff__ship {
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  padding: 0.6rem 0.8rem;
  margin-bottom: 0.25rem;
}
.hydra-diff__ship summary {
  cursor: pointer;
  font-weight: 600;
}
.hydra-diff__cmd {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.hydra-diff__cmd code {
  flex: 1;
  overflow: auto;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.14);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
  white-space: pre;
}
.hydra-diff__cmd-title {
  font-size: 0.75rem;
  opacity: 0.7;
}
.hydra-diff__hint {
  opacity: 0.7;
  padding: 1rem;
  font-size: 0.85rem;
}
`;

export function DiffStyles(): JSX.Element {
  return <style>{DIFF_CSS}</style>;
}
