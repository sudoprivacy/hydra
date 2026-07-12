import { useState } from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import { Bell, Megaphone, RefreshCw, RotateCw, Settings } from '../ui/icons';
import { SidebarHeader } from './SidebarHeader';
import { Tree } from './Tree';
import { useContextUi } from '../context/ContextState';
import { Menu } from './Menu';

export function Sidebar({ onToggleCompact }: { onToggleCompact: () => void }): JSX.Element {
  const { control, actions } = useSessions();
  const contextUi = useContextUi();
  const [query, setQuery] = useState('');

  return (
    <nav className="hydra-sidebar" aria-label="Sessions">
      <SidebarHeader query={query} onQueryChange={setQuery} onToggleCompact={onToggleCompact} />
      <button
        type="button"
        className={`hydra-sidebar__attention${
          contextUi.open && contextUi.mode === 'attention' ? ' hydra-sidebar__attention--active' : ''
        }`}
        aria-pressed={contextUi.open && contextUi.mode === 'attention'}
        onClick={contextUi.openAttention}
      >
        <span className="hydra-sidebar__attention-label">
          <Bell size={15} strokeWidth={1.7} aria-hidden="true" />
          <span>Attention</span>
        </span>
        {control.view && control.view.activeAttentionTotal > 0 ? (
          <span className="hydra-sidebar__attention-count">{control.view.activeAttentionTotal}</span>
        ) : null}
      </button>
      <div className="hydra-sidebar__scroll">
        {control.view ? (
          <Tree view={control.view} query={query} />
        ) : control.error ? (
          <p className="hydra-sidebar__status hydra-status--error">{control.error}</p>
        ) : (
          <p className="hydra-sidebar__status hydra-muted">Loading…</p>
        )}
      </div>
      <footer className="hydra-sidebar__footer">
        <div className="hydra-sidebar__local-user" aria-label="Local Hydra profile">
          <span className="hydra-sidebar__avatar" aria-hidden="true">H</span>
          <span className="hydra-sidebar__local-label">Hydra local</span>
        </div>
        <Menu
          label="Hydra settings and utilities"
          glyph={<Settings size={19} strokeWidth={1.65} />}
          align="right"
          className="hydra-sidebar__settings"
          items={[
            { key: 'refresh', label: 'Refresh sessions', icon: <RefreshCw size={14} />, onSelect: actions.refresh },
            { key: 'broadcast', label: 'Broadcast to workers…', icon: <Megaphone size={14} />, onSelect: actions.broadcast },
            { key: 'restore', label: 'Restore archived…', icon: <RotateCw size={14} />, onSelect: actions.restore },
          ]}
        />
      </footer>
    </nav>
  );
}
