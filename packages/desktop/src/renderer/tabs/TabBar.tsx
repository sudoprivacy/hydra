// The tab strip. Overview is a permanent leftmost tab (no close); session
// tabs carry a status dot (same vocabulary as the sidebar), a label, and a ×.
// needs-input / error tabs get an accent so their state reads without switching.

import type { TileModel } from '../missionControl/boardModel';
import { useSessions } from '../sessions/SessionsProvider';
import { isAttention, STATUS_LABELS, tileStatus, type SessionStatus } from '../status';
import { useTabs } from './TabsProvider';

export function TabBar(): JSX.Element {
  const tabs = useTabs();
  const { board } = useSessions();

  const tileBySession = new Map<string, TileModel>();
  if (board.view) {
    for (const group of board.view.groups) {
      for (const tile of group.tiles) {
        tileBySession.set(tile.session, tile);
      }
    }
  }

  return (
    <div className="hydra-tabbar" role="tablist">
      {tabs.tabs.map((tab) => {
        const active = tab.id === tabs.activeId;

        if (tab.kind === 'overview') {
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`hydra-tab hydra-tab--overview${active ? ' hydra-tab--active' : ''}`}
              onClick={() => tabs.focusTab(tab.id)}
            >
              <span className="hydra-tab__label">Overview</span>
            </button>
          );
        }

        const tile = tab.session ? tileBySession.get(tab.session) : undefined;
        const status: SessionStatus = tile ? tileStatus(tile) : 'unknown';
        const label = tile?.name ?? tab.session ?? 'session';

        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={tab.session}
            className={`hydra-tab${active ? ' hydra-tab--active' : ''}${
              isAttention(status) ? ' hydra-tab--attention' : ''
            }`}
            onClick={() => tabs.focusTab(tab.id)}
            onKeyDown={(event) => {
              if (event.currentTarget !== event.target) {
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                tabs.focusTab(tab.id);
              }
            }}
          >
            <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
            <span className="hydra-tab__label">{label}</span>
            <button
              type="button"
              className="hydra-tab__close"
              aria-label={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                tabs.closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
