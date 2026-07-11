// The per-row ⋮ action menu. Opens the same session verbs the Overview tiles use
// (via the shared session actions) plus tab navigation (Open Terminal / Diff).
// Diff and Stop are worker-only; stopped copilots hide Terminal because there is
// no live tmux session to attach to. Start appears when a session is stopped.

import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';
import type { TileModel } from '../missionControl/boardModel';
import { Menu, type MenuItem } from './Menu';

export function RowMenu({ tile }: { tile: TileModel }): JSX.Element {
  const tabs = useTabs();
  const { actions } = useSessions();

  const items: MenuItem[] = [];
  const openTile = (view: 'terminal' | 'diff') => {
    tabs.openTab(tile.session, tile.kind, {
      workerId: tile.kind === 'worker' ? tile.number : undefined,
      agentSessionId: tile.raw.agentSessionId,
      view,
    });
  };

  items.push({
    key: 'terminal',
    label: 'Open Terminal',
    onSelect: () => openTile('terminal'),
  });

  if (tile.kind === 'worker' && tile.type === 'code') {
    items.push({
      key: 'diff',
      label: 'Open Diff',
      onSelect: () => openTile('diff'),
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
