export type TabView = 'terminal' | 'diff';
export type TabSessionKind = 'worker' | 'copilot';

export interface SessionDescriptor {
  readonly session: string;
  readonly sessionKind: TabSessionKind;
  readonly status: string;
  readonly workerId?: number;
  readonly agentSessionId?: string | null;
}

export interface Tab {
  readonly id: string;
  readonly kind: 'session';
  readonly session: string;
  readonly sessionKind: TabSessionKind;
  readonly workerId?: number;
  readonly agentSessionId?: string | null;
  readonly view: TabView;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeId: string | null;
}

export interface OpenTabOptions {
  readonly workerId?: number;
  readonly agentSessionId?: string | null;
  readonly view?: TabView;
}

export type TabsAction =
  | { readonly type: 'open'; readonly descriptor: SessionDescriptor; readonly view?: TabView }
  | { readonly type: 'focus'; readonly id: string }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'setView'; readonly id: string; readonly view: TabView }
  | { readonly type: 'reconcile'; readonly sessions: readonly SessionDescriptor[] };

export const INITIAL_TABS_STATE: TabsState = { tabs: [], activeId: null };

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      const id = descriptorId(action.descriptor);
      const index = state.tabs.findIndex(tab =>
        tab.id === id
        || (tab.session === action.descriptor.session && tab.sessionKind === action.descriptor.sessionKind),
      );
      if (index >= 0) {
        const existing = state.tabs[index];
        const updated = tabFromDescriptor(action.descriptor, action.view ?? existing.view, existing.id);
        const tabs = replaceAt(state.tabs, index, updated);
        return { tabs, activeId: updated.id };
      }
      const tab = tabFromDescriptor(action.descriptor, action.view ?? 'terminal');
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }

    case 'focus':
      return state.activeId === action.id || !state.tabs.some(tab => tab.id === action.id)
        ? state
        : { ...state, activeId: action.id };

    case 'close': {
      const index = state.tabs.findIndex(tab => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter(tab => tab.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      const neighbour = state.tabs[index + 1] ?? state.tabs[index - 1];
      return { tabs, activeId: neighbour && tabs.some(tab => tab.id === neighbour.id) ? neighbour.id : null };
    }

    case 'setView': {
      const index = state.tabs.findIndex(tab => tab.id === action.id);
      if (index < 0 || state.tabs[index].view === action.view) return state;
      return {
        ...state,
        tabs: replaceAt(state.tabs, index, { ...state.tabs[index], view: action.view }),
      };
    }

    case 'reconcile': {
      const sessions = action.sessions;
      const tabs = state.tabs.flatMap(tab => {
        const descriptor = findDescriptorForTab(tab, sessions);
        return descriptor ? [tabFromDescriptor(descriptor, tab.view, tab.id)] : [];
      });
      const activeId = state.activeId && tabs.some(tab => tab.id === state.activeId)
        ? state.activeId
        : tabs[0]?.id ?? null;
      if (tabsEqual(tabs, state.tabs) && activeId === state.activeId) return state;
      return { tabs, activeId };
    }
  }
}

/** Product landing order. A true first run (zero Copilots) stays on FirstRun. */
export function chooseInitialSession(
  sessions: readonly SessionDescriptor[],
  lastCopilotSession: string | null,
): SessionDescriptor | null {
  const copilots = sessions.filter(session => session.sessionKind === 'copilot');
  if (copilots.length === 0) return null;
  const liveCopilots = copilots.filter(isLive);
  return liveCopilots.find(session => session.session === lastCopilotSession)
    ?? liveCopilots[0]
    ?? sessions.find(isLive)
    ?? null;
}

export function descriptorId(descriptor: SessionDescriptor): string {
  if (descriptor.sessionKind === 'worker' && descriptor.workerId !== undefined) {
    return `worker:${descriptor.workerId}`;
  }
  if (descriptor.sessionKind === 'copilot' && descriptor.agentSessionId) {
    return `copilot:${descriptor.agentSessionId}`;
  }
  return `${descriptor.sessionKind}:session:${descriptor.session}`;
}

function tabFromDescriptor(
  descriptor: SessionDescriptor,
  view: TabView,
  stableId = descriptorId(descriptor),
): Tab {
  return {
    id: stableId,
    kind: 'session',
    session: descriptor.session,
    sessionKind: descriptor.sessionKind,
    workerId: descriptor.workerId,
    agentSessionId: descriptor.agentSessionId,
    view,
  };
}

function findDescriptorForTab(
  tab: Tab,
  sessions: readonly SessionDescriptor[],
): SessionDescriptor | undefined {
  if (tab.sessionKind === 'worker' && tab.workerId !== undefined) {
    return sessions.find(session => session.sessionKind === 'worker' && session.workerId === tab.workerId);
  }
  if (tab.sessionKind === 'copilot' && tab.agentSessionId) {
    return sessions.find(session =>
      session.sessionKind === 'copilot'
      && session.agentSessionId === tab.agentSessionId,
    );
  }
  return sessions.find(session =>
    session.sessionKind === tab.sessionKind
    && session.session === tab.session,
  );
}

function isLive(session: SessionDescriptor): boolean {
  return session.status !== 'stopped';
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  const next = [...values];
  next[index] = value;
  return next;
}

function tabsEqual(left: readonly Tab[], right: readonly Tab[]): boolean {
  return left.length === right.length && left.every((tab, index) => {
    const other = right[index];
    return tab.id === other.id
      && tab.session === other.session
      && tab.sessionKind === other.sessionKind
      && tab.workerId === other.workerId
      && tab.agentSessionId === other.agentSessionId
      && tab.view === other.view;
  });
}
