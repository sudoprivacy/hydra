// TabsProvider — the navigation state for the IDE-style detail pane. There is no
// URL router anymore: which session you are looking at is React state, not a
// route. A pure reducer owns `{ tabs, activeId }`; the provider wraps it in
// stable callbacks (openTab / focusTab / closeTab / setView / pruneTabs).
//
// The Overview is a permanent, non-closable tab (kind:'overview'); session tabs
// use the tmux session name as their stable id, so opening the same session
// twice just refocuses it and callers can address a tab by session without
// threading an id back. Closing the last session tab falls back to Overview.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

export type TabView = 'terminal' | 'diff';
export type TabSessionKind = 'worker' | 'copilot';

export interface Tab {
  /** 'overview' for the Overview tab; the session name for session tabs. */
  readonly id: string;
  readonly kind: 'overview' | 'session';
  readonly session?: string;
  readonly sessionKind?: TabSessionKind;
  readonly view: TabView;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeId: string;
}

export const OVERVIEW_TAB_ID = 'overview';

const OVERVIEW_TAB: Tab = { id: OVERVIEW_TAB_ID, kind: 'overview', view: 'terminal' };

const INITIAL_STATE: TabsState = { tabs: [OVERVIEW_TAB], activeId: OVERVIEW_TAB_ID };

type Action =
  | { type: 'open'; session: string; sessionKind: TabSessionKind }
  | { type: 'focus'; id: string }
  | { type: 'close'; id: string }
  | { type: 'setView'; id: string; view: TabView }
  | { type: 'prune'; valid: ReadonlySet<string> };

function reducer(state: TabsState, action: Action): TabsState {
  switch (action.type) {
    case 'open': {
      const existing = state.tabs.find((tab) => tab.id === action.session);
      if (existing) {
        return state.activeId === action.session ? state : { ...state, activeId: action.session };
      }
      const tab: Tab = {
        id: action.session,
        kind: 'session',
        session: action.session,
        sessionKind: action.sessionKind,
        view: 'terminal',
      };
      return { tabs: [...state.tabs, tab], activeId: action.session };
    }

    case 'focus': {
      if (!state.tabs.some((tab) => tab.id === action.id) || state.activeId === action.id) {
        return state;
      }
      return { ...state, activeId: action.id };
    }

    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0 || state.tabs[index].kind === 'overview') {
        return state; // Overview is never closable.
      }
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      let activeId = state.activeId;
      if (activeId === action.id) {
        // Prefer the tab to the right, matching editor/browser tab closing.
        const neighbour = state.tabs[index + 1] ?? state.tabs[index - 1];
        activeId = neighbour ? neighbour.id : OVERVIEW_TAB_ID;
      }
      return { tabs, activeId };
    }

    case 'setView': {
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (tab.id === action.id && tab.view !== action.view) {
          changed = true;
          return { ...tab, view: action.view };
        }
        return tab;
      });
      return changed ? { ...state, tabs } : state;
    }

    case 'prune': {
      const tabs = state.tabs.filter(
        (tab) => tab.kind === 'overview' || action.valid.has(tab.id),
      );
      if (tabs.length === state.tabs.length) {
        return state;
      }
      const activeId = tabs.some((tab) => tab.id === state.activeId)
        ? state.activeId
        : OVERVIEW_TAB_ID;
      return { tabs, activeId };
    }

    default:
      return state;
  }
}

export interface TabsApi extends TabsState {
  /** Open (or refocus) a session tab; new tabs start on the terminal view. */
  openTab: (session: string, sessionKind: TabSessionKind) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  setView: (id: string, view: TabView) => void;
  /** Drop session tabs whose session no longer exists (deleted elsewhere). */
  pruneTabs: (valid: ReadonlySet<string>) => void;
}

const TabsContext = createContext<TabsApi | null>(null);

export function TabsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const openTab = useCallback((session: string, sessionKind: TabSessionKind) => {
    dispatch({ type: 'open', session, sessionKind });
  }, []);

  const focusTab = useCallback((id: string) => {
    dispatch({ type: 'focus', id });
  }, []);

  const closeTab = useCallback((id: string) => {
    dispatch({ type: 'close', id });
  }, []);

  const setView = useCallback((id: string, view: TabView) => {
    dispatch({ type: 'setView', id, view });
  }, []);

  const pruneTabs = useCallback((valid: ReadonlySet<string>) => {
    dispatch({ type: 'prune', valid });
  }, []);

  const api = useMemo<TabsApi>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      openTab,
      focusTab,
      closeTab,
      setView,
      pruneTabs,
    }),
    [state.tabs, state.activeId, openTab, focusTab, closeTab, setView, pruneTabs],
  );

  return <TabsContext.Provider value={api}>{children}</TabsContext.Provider>;
}

/** Access the tab navigation state. Throws if used outside <TabsProvider>. */
export function useTabs(): TabsApi {
  const api = useContext(TabsContext);
  if (!api) {
    throw new Error('useTabs must be used within <TabsProvider>');
  }
  return api;
}
