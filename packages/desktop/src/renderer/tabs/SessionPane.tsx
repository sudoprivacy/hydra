// One session's detail pane: a Terminal | Diff segmented toggle (workers only —
// copilots show the terminal alone) over the actual views.
//
// Keep-alive within the pane mirrors the tab shell: the terminal is ALWAYS
// mounted (its WebSocket must never drop), and we toggle `hidden` to switch to
// the diff rather than unmounting it. The diff is mounted lazily on first use,
// then kept, so re-selecting either view is instant. `active` (this pane is the
// visible tab) AND the terminal being the shown view drives xterm's refit.

import { useEffect, useState } from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import { WorkerTerminal } from '../routes/WorkerTerminal';
import { WorkerDiff } from '../routes/WorkerDiff';
import { useTabs, type Tab } from './TabsProvider';

export function SessionPane({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  const tabs = useTabs();
  const { board } = useSessions();
  const session = tab.session ?? '';
  const isWorker = tab.sessionKind === 'worker';
  const view = isWorker ? tab.view : 'terminal';

  // Prefer the friendly name (+ #number for workers) over the raw tmux id.
  let title = session;
  for (const group of board.view?.groups ?? []) {
    const tile = group.tiles.find((candidate) => candidate.session === session);
    if (tile) {
      title = tile.kind === 'worker' ? `${tile.name} #${tile.number}` : tile.name;
      break;
    }
  }

  // Mount the diff on first switch to it, then leave it mounted (hidden).
  const [diffMounted, setDiffMounted] = useState(view === 'diff');
  useEffect(() => {
    if (view === 'diff') {
      setDiffMounted(true);
    }
  }, [view]);

  return (
    <div className="hydra-pane__inner">
      {isWorker ? (
        <div className="hydra-pane__toolbar">
          <span className="hydra-pane__title" title={session}>
            {title}
          </span>
          <div className="hydra-seg-toggle" role="tablist" aria-label="View">
            <ToggleButton label="Terminal" active={view === 'terminal'} onClick={() => tabs.setView(tab.id, 'terminal')} />
            <ToggleButton label="Diff" active={view === 'diff'} onClick={() => tabs.setView(tab.id, 'diff')} />
          </div>
        </div>
      ) : null}

      <div className="hydra-pane__body">
        <div className="hydra-pane__view" hidden={view !== 'terminal'}>
          <WorkerTerminal session={session} active={active && view === 'terminal'} />
        </div>
        {isWorker && diffMounted ? (
          <div className="hydra-pane__view" hidden={view !== 'diff'}>
            <WorkerDiff session={session} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`hydra-seg-toggle__btn${active ? ' hydra-seg-toggle__btn--active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
