// One session row in the sidebar tree. Shows a status dot + name + #number +
// [agent], with a muted second line (e.g. `idle · U:2` for workers, or a
// relative time for copilots). Clicking the row opens/focuses its tab when the
// session has an attachable terminal; the ⋮ menu carries the per-row actions.
// The row is highlighted when its tab is active.

import type { TileModel } from '../missionControl/boardModel';
import { relativeTime } from '../missionControl/format';
import { STATUS_LABELS, tileStatus } from '../status';
import { useTabs } from '../tabs/TabsProvider';
import { RowMenu } from './RowMenu';

export function TreeRow({ tile }: { tile: TileModel }): JSX.Element {
  const tabs = useTabs();
  const status = tileStatus(tile);
  const selected = tabs.activeId === tile.session;
  const canOpenTerminal = tile.kind === 'worker' || tile.lifecycle !== 'stopped';

  const subline =
    tile.kind === 'worker'
      ? `${STATUS_LABELS[status].toLowerCase()}${tile.unread > 0 ? ` · U:${tile.unread}` : ''}`
      : tile.unread > 0
        ? `U:${tile.unread}`
        : relativeTime(tile.lastEventAt);

  return (
    <div
      className={`hydra-row${selected ? ' hydra-row--selected' : ''}${
        canOpenTerminal ? '' : ' hydra-row--no-open'
      }`}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      title={tile.session}
      onClick={() => {
        if (canOpenTerminal) {
          tabs.openTab(tile.session, tile.kind);
        }
      }}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (canOpenTerminal) {
            tabs.openTab(tile.session, tile.kind);
          }
        }
      }}
    >
      <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
      <div className="hydra-row__main">
        <div className="hydra-row__line">
          <span className="hydra-row__name">{tile.name}</span>
          {tile.kind === 'worker' ? <span className="hydra-row__num">#{tile.number}</span> : null}
          <span className="hydra-row__agent">[{tile.agent}]</span>
        </div>
        <div className="hydra-row__sub">{subline}</div>
      </div>
      <RowMenu tile={tile} />
    </div>
  );
}
