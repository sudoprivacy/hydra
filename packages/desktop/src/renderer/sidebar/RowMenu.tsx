// The per-row ⋮ action menu. Opens the same session verbs the Overview tiles use
// (via the shared session actions) plus tab navigation (Open Terminal / Diff).
// Diff and Stop are worker-only; Start appears when the session is stopped.

import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';
import type { TileModel } from '../missionControl/boardModel';
import { Menu, type MenuItem } from './Menu';

export function RowMenu({ tile }: { tile: TileModel }): JSX.Element {
  const tabs = useTabs();
  const { actions } = useSessions();

  const items: MenuItem[] = [
    {
      key: 'terminal',
      label: 'Open Terminal',
      onSelect: () => {
        tabs.openTab(tile.session, tile.kind);
        tabs.setView(tile.session, 'terminal');
      },
    },
  ];

  if (tile.kind === 'worker') {
    items.push({
      key: 'diff',
      label: 'Open Diff',
      onSelect: () => {
        tabs.openTab(tile.session, tile.kind);
        tabs.setView(tile.session, 'diff');
      },
    });
  }

  items.push(
    { key: 'send', label: 'Send message…', onSelect: () => actions.send(tile) },
    { key: 'rename', label: 'Rename…', onSelect: () => actions.rename(tile) },
  );

  if (tile.lifecycle === 'running') {
    if (tile.kind === 'worker') {
      items.push({ key: 'stop', label: 'Stop', onSelect: () => actions.stop(tile) });
    }
  } else {
    items.push({ key: 'start', label: 'Start', onSelect: () => actions.start(tile) });
  }

  items.push({ key: 'delete', label: 'Delete…', danger: true, onSelect: () => actions.delete(tile) });

  return <Menu label={`Actions for ${tile.name}`} glyph="⋮" align="right" items={items} className="hydra-row__menu" />;
}
