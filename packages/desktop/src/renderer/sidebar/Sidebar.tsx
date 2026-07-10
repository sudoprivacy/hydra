// The left sidebar: header controls, the ⌂ Overview entry, and the session tree.
// It reads the shared board for the tree data and the tab state for the current
// selection (so the Overview entry highlights when the Overview tab is active).

import { useSessions } from '../sessions/SessionsProvider';
import { OVERVIEW_TAB_ID, useTabs } from '../tabs/TabsProvider';
import { SidebarHeader } from './SidebarHeader';
import { Tree } from './Tree';

export function Sidebar(): JSX.Element {
  const { board } = useSessions();
  const tabs = useTabs();
  const overviewSelected = tabs.activeId === OVERVIEW_TAB_ID;

  return (
    <nav className="hydra-sidebar" aria-label="Sessions">
      <SidebarHeader />
      <div className="hydra-sidebar__scroll">
        <button
          type="button"
          className={`hydra-overview-entry${overviewSelected ? ' hydra-overview-entry--selected' : ''}`}
          aria-current={overviewSelected}
          onClick={() => tabs.focusTab(OVERVIEW_TAB_ID)}
        >
          <span className="hydra-overview-entry__mark" aria-hidden="true" />
          <span>Overview</span>
        </button>

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
