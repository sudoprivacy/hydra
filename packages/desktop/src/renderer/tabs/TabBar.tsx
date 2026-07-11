import type { TileModel } from '../missionControl/boardModel';
import { useSessions } from '../sessions/SessionsProvider';
import { isAttention, STATUS_LABELS, tileStatus, type SessionStatus } from '../status';
import { useTabs } from './TabsProvider';

export function TabBar(): JSX.Element {
  const tabs = useTabs();
  const { board } = useSessions();
  const tileBySession = new Map<string, TileModel>();
  for (const group of board.view?.groups ?? []) {
    for (const tile of group.tiles) tileBySession.set(tile.session, tile);
  }

  return (
    <div className="hydra-tabbar" role="tablist" aria-label="Open sessions">
      {tabs.tabs.map(tab => {
        const active = tab.id === tabs.activeId;
        const tile = tileBySession.get(tab.session);
        const status: SessionStatus = tile ? tileStatus(tile) : 'unknown';
        const label = tile?.name ?? tab.session;
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
            onKeyDown={event => {
              if (event.currentTarget !== event.target) return;
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
              onClick={event => {
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
