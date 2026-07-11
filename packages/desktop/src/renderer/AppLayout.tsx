// AppLayout — the IDE-style two-pane shell: a resizable Sidebar, a drag handle,
// the TabArea, and the StatusBar pinned to the bottom. The sidebar width is
// clamped (~236–340px) and persisted in localStorage so it survives relaunch.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Sidebar } from './sidebar/Sidebar';
import { TabArea } from './tabs/TabArea';
import { useShellUi } from './shell/shellState';
import { ContextDrawer } from './context/ContextDrawer';

const MIN_WIDTH = 236;
const MAX_WIDTH = 340;
const DEFAULT_WIDTH = 272;
const STORAGE_KEY = 'hydra.sidebarWidth.v2';
interface DragState {
  readonly x: number;
  readonly width: number;
  readonly pointerId: number;
  readonly handle: HTMLDivElement;
}

const clampWidth = (px: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));

function loadWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function AppLayout(): JSX.Element {
  const shell = useShellUi();
  const [width, setWidth] = useState(loadWidth);
  const dragStart = useRef<DragState | null>(null);

  // Persist width whenever it settles (cheap; the app writes one small number).
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // Storage can be unavailable (private mode); the width simply won't persist.
    }
  }, [width]);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    setWidth(clampWidth(start.width + (event.clientX - start.x)));
  }, []);

  const stopDrag = useCallback(() => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    dragStart.current = null;
    try {
      if (start.handle.hasPointerCapture(start.pointerId)) {
        start.handle.releasePointerCapture(start.pointerId);
      }
    } catch {
      // The browser may already have released capture after pointer cancellation.
    }
    document.body.classList.remove('hydra-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      dragStart.current = {
        x: event.clientX,
        width,
        pointerId: event.pointerId,
        handle: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('hydra-resizing');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
      window.addEventListener('blur', stopDrag);
      event.preventDefault();
    },
    [width, onPointerMove, stopDrag],
  );

  // Detach any stray listeners if we unmount mid-drag.
  useEffect(() => stopDrag, [stopDrag]);

  return (
    <div className={`hydra-app${shell.terminalMaximized ? ' hydra-app--terminal-maximized' : ''}`}>
      <div className="hydra-app__main">
        {!shell.terminalMaximized ? (
          <>
            <div className="hydra-app__sidebar" style={{ width }}>
              <Sidebar />
            </div>
            <div
              className="hydra-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={startDrag}
            />
          </>
        ) : null}
        <div className="hydra-app__tabs">
          <TabArea />
          {!shell.terminalMaximized ? <ContextDrawer /> : null}
        </div>
      </div>
    </div>
  );
}
