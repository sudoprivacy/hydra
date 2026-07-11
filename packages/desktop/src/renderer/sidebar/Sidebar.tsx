// The left sidebar: fleet controls and the authoritative Copilot/Worker tree.

import { useSessions } from '../sessions/SessionsProvider';
import { SidebarHeader } from './SidebarHeader';
import { Tree } from './Tree';
import { useContextUi } from '../context/ContextState';

export function Sidebar(): JSX.Element {
  const { board, control } = useSessions();
  const contextUi = useContextUi();

  return (
    <nav className="hydra-sidebar" aria-label="Sessions">
      <SidebarHeader />
      <button
        type="button"
        className={`hydra-sidebar__attention${
          contextUi.open && contextUi.mode === 'attention' ? ' hydra-sidebar__attention--active' : ''
        }`}
        aria-pressed={contextUi.open && contextUi.mode === 'attention'}
        onClick={contextUi.openAttention}
      >
        <span>Attention</span>
        {control.view && control.view.activeAttentionTotal > 0 ? (
          <span className="hydra-sidebar__attention-count">{control.view.activeAttentionTotal}</span>
        ) : null}
      </button>
      <div className="hydra-sidebar__scroll">
        {board.view ? (
          <Tree view={board.view} />
        ) : board.error ? (
          <p className="hydra-sidebar__status hydra-status--error">{board.error}</p>
        ) : (
          <p className="hydra-sidebar__status hydra-muted">Loading…</p>
        )}
      </div>
    </nav>
  );
}
