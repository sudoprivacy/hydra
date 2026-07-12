// AppLayout — the IDE-style two-pane shell: a resizable Sidebar, a drag handle,
// the terminal-first session workspace. The sidebar width is
// clamped (~228–320px) and persisted in localStorage so it survives relaunch.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { Sidebar } from './sidebar/Sidebar';
import { TabArea } from './tabs/TabArea';
import { useShellUi } from './shell/shellState';
import { ContextDrawer } from './context/ContextDrawer';

const MIN_WIDTH = 228;
const MAX_WIDTH = 320;
const DEFAULT_WIDTH = 296;
// v3 intentionally resets the roomier concept-mock width for existing installs.
const STORAGE_KEY = 'hydra.sidebarWidth.v3';
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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const pendingWidth = useRef(width);
  const resizeFrame = useRef<number | null>(null);

  // Persist width whenever it settles (cheap; the app writes one small number).
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // Storage can be unavailable (private mode); the width simply won't persist.
    }
  }, [width]);

  const previewWidth = useCallback((nextWidth: number) => {
    pendingWidth.current = nextWidth;
    if (resizeFrame.current !== null) return;
    resizeFrame.current = requestAnimationFrame(() => {
      resizeFrame.current = null;
      if (sidebarRef.current) sidebarRef.current.style.width = `${pendingWidth.current}px`;
    });
  }, []);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    previewWidth(clampWidth(start.width + (event.clientX - start.x)));
  }, [previewWidth]);

  const stopDrag = useCallback(() => {
    const start = dragStart.current;
    if (!start) {
      return;
    }
    dragStart.current = null;
    if (resizeFrame.current !== null) {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = null;
    }
    const finalWidth = pendingWidth.current;
    if (sidebarRef.current) sidebarRef.current.style.width = `${finalWidth}px`;
    // Commit once at pointerup so React, storage, and terminal fitting do not
    // churn on every pointermove.
    setWidth(finalWidth);
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
      pendingWidth.current = width;
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

  const toggleCompactSidebar = useCallback(() => {
    setWidth(current => current <= MIN_WIDTH + 4 ? DEFAULT_WIDTH : MIN_WIDTH);
  }, []);

  const onResizerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | undefined;
    if (event.key === 'ArrowLeft') nextWidth = clampWidth(width - 8);
    else if (event.key === 'ArrowRight') nextWidth = clampWidth(width + 8);
    else if (event.key === 'Home') nextWidth = MIN_WIDTH;
    else if (event.key === 'End') nextWidth = MAX_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    pendingWidth.current = nextWidth;
    setWidth(nextWidth);
  }, [width]);

  return (
    <div className={`hydra-app${shell.terminalMaximized ? ' hydra-app--terminal-maximized' : ''}`}>
      <div className="hydra-app__main">
        {!shell.terminalMaximized ? (
          <>
            <div ref={sidebarRef} className="hydra-app__sidebar" style={{ width }}>
              <Sidebar onToggleCompact={toggleCompactSidebar} />
            </div>
            <div
              className="hydra-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={MAX_WIDTH}
              aria-valuenow={width}
              tabIndex={0}
              onPointerDown={startDrag}
              onKeyDown={onResizerKeyDown}
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
