import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

import { useTabs, type TabSessionKind } from '../tabs/TabsProvider';
import {
  contextUiReducer,
  INITIAL_CONTEXT_UI_STATE,
  type ContextMode,
  type ContextUiSnapshot,
} from './contextStateModel';

const CONTEXT_OPEN_STORAGE_KEY = 'hydra.contextOpen.v2';

export interface ContextUiApi extends ContextUiSnapshot {
  readonly openForSession: (kind: TabSessionKind, session: string) => void;
  readonly toggleForSession: (kind: TabSessionKind, session: string) => void;
  readonly openAttention: () => void;
  readonly close: () => void;
  readonly isOpenFor: (kind: TabSessionKind, session: string) => boolean;
}

const ContextUiContext = createContext<ContextUiApi | null>(null);

export function ContextUiProvider({ children }: { children: ReactNode }): JSX.Element {
  const tabs = useTabs();
  const [state, dispatch] = useReducer(contextUiReducer, {
    ...INITIAL_CONTEXT_UI_STATE,
    open: loadOpenPreference(),
  });

  useEffect(() => {
    const tab = tabs.activeTab;
    if (!tab) return;
    dispatch({ type: 'sync-session', mode: tab.sessionKind, session: tab.session });
  }, [tabs.activeTab]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CONTEXT_OPEN_STORAGE_KEY, state.open ? '1' : '0');
    } catch {
      // Local presentation preferences are best effort.
    }
  }, [state.open]);

  const openForSession = useCallback((kind: TabSessionKind, session: string) => {
    dispatch({ type: 'open-session', mode: kind, session });
  }, []);
  const toggleForSession = useCallback((kind: TabSessionKind, session: string) => {
    dispatch({ type: 'toggle-session', mode: kind, session });
  }, []);
  const openAttention = useCallback(() => dispatch({ type: 'open-attention' }), []);
  const close = useCallback(() => dispatch({ type: 'close' }), []);
  const isOpenFor = useCallback((kind: TabSessionKind, session: string) => (
    state.open && state.mode === kind && state.subjectSession === session
  ), [state]);

  const value = useMemo<ContextUiApi>(() => ({
    ...state,
    openForSession,
    toggleForSession,
    openAttention,
    close,
    isOpenFor,
  }), [state, openForSession, toggleForSession, openAttention, close, isOpenFor]);

  return <ContextUiContext.Provider value={value}>{children}</ContextUiContext.Provider>;
}

export function useContextUi(): ContextUiApi {
  const value = useContext(ContextUiContext);
  if (!value) throw new Error('useContextUi must be used within <ContextUiProvider>');
  return value;
}

function loadOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(CONTEXT_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export type { ContextMode };
