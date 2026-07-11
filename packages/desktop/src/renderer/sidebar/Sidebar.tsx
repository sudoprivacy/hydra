// The left sidebar: fleet controls and the authoritative Copilot/Worker tree.

import { useSessions } from '../sessions/SessionsProvider';
import { SidebarHeader } from './SidebarHeader';
import { Tree } from './Tree';

export function Sidebar(): JSX.Element {
  const { board } = useSessions();

  return (
    <nav className="hydra-sidebar" aria-label="Sessions">
      <SidebarHeader />
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
