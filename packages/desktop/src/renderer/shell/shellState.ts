import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface ShellUiState {
  readonly terminalMaximized: boolean;
  readonly maximizeTerminal: () => void;
  readonly restoreTerminal: () => void;
  readonly toggleTerminalMaximized: () => void;
}

const ShellUiContext = createContext<ShellUiState | null>(null);

export function ShellUiProvider({ children }: { children: ReactNode }): ReactElement {
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const maximizeTerminal = useCallback(() => setTerminalMaximized(true), []);
  const restoreTerminal = useCallback(() => setTerminalMaximized(false), []);
  const toggleTerminalMaximized = useCallback(() => setTerminalMaximized(value => !value), []);

  useEffect(() => {
    if (!terminalMaximized) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || isTerminalInput(event.target)) return;
      event.preventDefault();
      setTerminalMaximized(false);
    };
    globalThis.window.addEventListener('keydown', onKeyDown);
    return () => globalThis.window.removeEventListener('keydown', onKeyDown);
  }, [terminalMaximized]);

  const value = useMemo<ShellUiState>(() => ({
    terminalMaximized,
    maximizeTerminal,
    restoreTerminal,
    toggleTerminalMaximized,
  }), [terminalMaximized, maximizeTerminal, restoreTerminal, toggleTerminalMaximized]);
  return createElement(ShellUiContext.Provider, { value }, children);
}

export function useShellUi(): ShellUiState {
  const value = useContext(ShellUiContext);
  if (!value) throw new Error('useShellUi must be used within <ShellUiProvider>');
  return value;
}

function isTerminalInput(target: EventTarget | null): boolean {
  return target instanceof globalThis.HTMLElement && Boolean(target.closest('.xterm'));
}
