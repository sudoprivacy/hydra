// TabArea — the right pane. It renders the TabBar and, below it, EVERY open
// pane at once. This is the keep-alive contract: panes are mounted for the whole
// life of the tab and only toggled with `hidden` (→ display:none), never
// conditionally mounted/unmounted. So switching tabs never remounts a
// WorkerTerminal — its WebSocket stays connected and its scrollback is intact.

import { useEffect } from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import { OverviewTab } from '../Overview/OverviewTab';
import { SessionPane } from './SessionPane';
import { TabBar } from './TabBar';
import { useTabs } from './TabsProvider';

export function TabArea(): JSX.Element {
  const { tabs, activeId, pruneTabs } = useTabs();
  const { board } = useSessions();

  // Close tabs whose session was deleted elsewhere. `pruneTabs` is a no-op when
  // nothing changed, so this settles immediately (dispatch is stable, so the
  // stale-closure caveat does not apply). Overview is never pruned.
  const view = board.view;
  useEffect(() => {
    if (!view) {
      return;
    }
    const valid = new Set<string>();
    for (const group of view.groups) {
      for (const tile of group.tiles) {
        valid.add(tile.session);
      }
    }
    pruneTabs(valid);
  }, [view, pruneTabs]);

  return (
    <div className="hydra-tabarea">
      <TabBar />
      <div className="hydra-tabarea__panes">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div key={tab.id} className="hydra-pane" hidden={!active}>
              {tab.kind === 'overview' ? (
                <OverviewTab />
              ) : (
                <SessionPane tab={tab} active={active} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
