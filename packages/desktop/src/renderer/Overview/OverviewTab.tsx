// The Overview tab — the existing Mission Control card grid, repurposed as the
// default tab content. It sources everything from the shared providers: the live
// board + fleet actions (SessionsProvider) and tab navigation (TabsProvider),
// so a tile's terminal/diff buttons open tabs instead of navigating a URL.

import { MissionControlBoard } from '../missionControl/MissionControlBoard';
import type { TileActions } from '../missionControl/SessionTile';
import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';

export function OverviewTab(): JSX.Element {
  const { board, actions } = useSessions();
  const tabs = useTabs();

  if (board.error && !board.view) {
    return <p className="hydra-status hydra-status--error">Failed to load sessions: {board.error}</p>;
  }
  if (!board.view) {
    return <p className="hydra-status">Loading sessions…</p>;
  }

  const tileActions: TileActions = {
    onOpen: (tile, view) => {
      tabs.openTab(tile.session, tile.kind);
      tabs.setView(tile.session, view);
    },
    onSend: actions.send,
    onRename: actions.rename,
    onDelete: actions.delete,
    onStart: actions.start,
    onStop: actions.stop,
  };

  return (
    <div className="hydra-overview">
      <MissionControlBoard
        view={board.view}
        connected={board.connected}
        lastSeq={board.lastSeq}
        onRefresh={actions.refresh}
        onCreate={actions.create}
        onBroadcast={actions.broadcast}
        onRestore={actions.restore}
        tileActions={tileActions}
      />
    </div>
  );
}
