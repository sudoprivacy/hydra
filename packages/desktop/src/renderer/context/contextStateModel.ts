export type ContextMode = 'copilot' | 'worker' | 'attention';

export interface ContextUiSnapshot {
  readonly open: boolean;
  readonly mode: ContextMode;
  readonly subjectSession: string | null;
}

export type ContextUiAction =
  | { readonly type: 'toggle-session'; readonly mode: Exclude<ContextMode, 'attention'>; readonly session: string }
  | { readonly type: 'open-session'; readonly mode: Exclude<ContextMode, 'attention'>; readonly session: string }
  | { readonly type: 'sync-session'; readonly mode: Exclude<ContextMode, 'attention'>; readonly session: string }
  | { readonly type: 'open-attention' }
  | { readonly type: 'close' };

export const INITIAL_CONTEXT_UI_STATE: ContextUiSnapshot = {
  open: false,
  mode: 'copilot',
  subjectSession: null,
};

export function contextUiReducer(
  state: ContextUiSnapshot,
  action: ContextUiAction,
): ContextUiSnapshot {
  switch (action.type) {
    case 'toggle-session':
      if (state.open && state.mode === action.mode && state.subjectSession === action.session) {
        return { ...state, open: false };
      }
      return { open: true, mode: action.mode, subjectSession: action.session };

    case 'open-session':
      return state.open && state.mode === action.mode && state.subjectSession === action.session
        ? state
        : { open: true, mode: action.mode, subjectSession: action.session };

    case 'sync-session':
      if (!state.open || state.mode === 'attention') return state;
      return state.mode === action.mode && state.subjectSession === action.session
        ? state
        : { ...state, mode: action.mode, subjectSession: action.session };

    case 'open-attention':
      return state.open && state.mode === 'attention'
        ? state
        : { open: true, mode: 'attention', subjectSession: null };

    case 'close':
      return state.open ? { ...state, open: false } : state;
  }
}
