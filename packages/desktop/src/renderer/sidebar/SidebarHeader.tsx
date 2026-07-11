import { useEffect, useRef } from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';
import {
  ChevronDown,
  Folder,
  GitBranch,
  PanelLeft,
  Plus,
  Search,
} from '../ui/icons';
import { Menu } from './Menu';

export function SidebarHeader({
  query,
  onQueryChange,
  onToggleCompact,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onToggleCompact: () => void;
}): JSX.Element {
  const { actions } = useSessions();
  const tabs = useTabs();
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedCopilot = tabs.activeTab?.sessionKind === 'copilot'
    ? tabs.activeTab.session
    : undefined;
  const shortcutLabel = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? '⌘K'
    : 'Ctrl K';

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  return (
    <header className="hydra-sidebar__header">
      <div className="hydra-sidebar__title-row">
        <span className="hydra-sidebar__brand">
          <img src="./assets/hydra-mark.svg" alt="" aria-hidden="true" />
          <span>Hydra</span>
        </span>
        <div className="hydra-sidebar__tools">
          <button
            type="button"
            className="hydra-iconbtn"
            title="Toggle compact sidebar"
            aria-label="Toggle compact sidebar"
            onClick={onToggleCompact}
          >
            <PanelLeft size={15} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      <label className="hydra-sidebar__search">
        <Search size={14} strokeWidth={1.7} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search Copilots and Workers"
          onChange={event => onQueryChange(event.target.value)}
        />
        <kbd>{shortcutLabel}</kbd>
      </label>

      <div className="hydra-sidebar__create-row">
        <button
          type="button"
          className="hydra-sidebar__new-copilot"
          onClick={() => actions.create('copilot')}
        >
          <Plus size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>New copilot</span>
        </button>
        <Menu
          label="Create Worker or Local Task"
          glyph={(
            <>
              <Plus size={15} strokeWidth={1.8} />
              <ChevronDown size={12} strokeWidth={1.8} />
            </>
          )}
          align="right"
          className="hydra-sidebar__create-menu"
          items={[
            {
              key: 'worker',
              label: 'New Code Worker…',
              icon: <GitBranch size={14} />,
              onSelect: () => actions.create('worker', {
                workerType: 'code',
                copilotSession: selectedCopilot,
              }),
            },
            {
              key: 'task',
              label: 'New Local Task…',
              icon: <Folder size={14} />,
              onSelect: () => actions.create('worker', {
                workerType: 'task',
                copilotSession: selectedCopilot,
              }),
            },
          ]}
        />
      </div>
    </header>
  );
}
