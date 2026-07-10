// The sidebar title bar: the Hydra wordmark plus the fleet-level controls —
// + create (Worker / Copilot), ... more (Broadcast / Restore), and refresh.
// Every control delegates to the shared session actions.

import { useSessions } from '../sessions/SessionsProvider';
import { Menu } from './Menu';

export function SidebarHeader(): JSX.Element {
  const { actions } = useSessions();

  return (
    <header className="hydra-sidebar__header">
      <span className="hydra-sidebar__brand">Hydra</span>
      <div className="hydra-sidebar__tools">
        <Menu
          label="Create session"
          glyph="+"
          align="left"
          items={[
            { key: 'worker', label: 'New Worker…', onSelect: () => actions.create('worker') },
            { key: 'copilot', label: 'New Copilot…', onSelect: () => actions.create('copilot') },
          ]}
        />
        <Menu
          label="More actions"
          glyph="..."
          align="right"
          items={[
            { key: 'broadcast', label: 'Broadcast to workers…', onSelect: actions.broadcast },
            { key: 'restore', label: 'Restore archived…', onSelect: actions.restore },
          ]}
        />
        <button
          type="button"
          className="hydra-iconbtn"
          title="Refresh"
          aria-label="Refresh"
          onClick={actions.refresh}
        >
          ↻
        </button>
      </div>
    </header>
  );
}
