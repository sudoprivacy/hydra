import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import {
  chooseInitialSession,
  INITIAL_TABS_STATE,
  tabsReducer,
  type OpenTabOptions,
  type SessionDescriptor,
  type Tab,
  type TabSessionKind,
  type TabsState,
  type TabView,
} from './tabState';

export type { OpenTabOptions, Tab, TabSessionKind, TabsState, TabView } from './tabState';

const LAST_COPILOT_STORAGE_KEY = 'hydra.lastCopilotSession.v2';

export interface TabsApi extends TabsState {
  readonly activeTab: Tab | null;
  readonly activeSession: string | null;
  openTab: (
    session: string,
    sessionKind: TabSessionKind,
    options?: OpenTabOptions,
  ) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  setView: (id: string, view: TabView) => void;
}

const TabsContext = createContext<TabsApi | null>(null);

export function TabsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { control } = useSessions();
  const [state, dispatch] = useReducer(tabsReducer, INITIAL_TABS_STATE);
  const bootstrapped = useRef(false);

  const descriptors = useMemo<SessionDescriptor[]>(() => {
    const view = control.view;
    if (!view) return [];
    return [
      ...view.copilots.map(copilot => ({
        session: copilot.session,
        sessionKind: 'copilot' as const,
        status: copilot.lifecycle,
        agentSessionId: copilot.raw.agentSessionId,
      })),
      ...view.workers.map(worker => ({
        session: worker.session,
        sessionKind: 'worker' as const,
        status: worker.lifecycle,
        workerId: worker.workerId,
        agentSessionId: worker.raw.agentSessionId,
      })),
    ];
  }, [control.view]);

  useEffect(() => {
    if (!control.view) return;
    dispatch({ type: 'reconcile', sessions: descriptors });
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const initial = chooseInitialSession(descriptors, loadLastCopilotSession());
    if (initial) dispatch({ type: 'open', descriptor: initial });
  }, [control.view, descriptors]);

  const activeTab = state.tabs.find(tab => tab.id === state.activeId) ?? null;
  useEffect(() => {
    if (activeTab?.sessionKind !== 'copilot') return;
    try {
      window.localStorage.setItem(LAST_COPILOT_STORAGE_KEY, activeTab.session);
    } catch {
      // Local preferences are best effort.
    }
  }, [activeTab]);

  const openTab = useCallback((
    session: string,
    sessionKind: TabSessionKind,
    options: OpenTabOptions = {},
  ) => {
    dispatch({
      type: 'open',
      descriptor: {
        session,
        sessionKind,
        status: 'running',
        workerId: options.workerId,
        agentSessionId: options.agentSessionId,
      },
      view: options.view,
    });
  }, []);

  const focusTab = useCallback((id: string) => dispatch({ type: 'focus', id }), []);
  const closeTab = useCallback((id: string) => dispatch({ type: 'close', id }), []);
  const setView = useCallback((id: string, view: TabView) => {
    dispatch({ type: 'setView', id, view });
  }, []);

  const api = useMemo<TabsApi>(() => ({
    tabs: state.tabs,
    activeId: state.activeId,
    activeTab,
    activeSession: activeTab?.session ?? null,
    openTab,
    focusTab,
    closeTab,
    setView,
  }), [state.tabs, state.activeId, activeTab, openTab, focusTab, closeTab, setView]);

  return <TabsContext.Provider value={api}>{children}</TabsContext.Provider>;
}

export function useTabs(): TabsApi {
  const api = useContext(TabsContext);
  if (!api) throw new Error('useTabs must be used within <TabsProvider>');
  return api;
}

function loadLastCopilotSession(): string | null {
  try {
    return window.localStorage.getItem(LAST_COPILOT_STORAGE_KEY);
  } catch {
    return null;
  }
}
