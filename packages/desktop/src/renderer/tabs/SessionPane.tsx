import { useEffect, useMemo, useState } from 'react';

import type { TileModel } from '../missionControl/boardModel';
import { WorkerDiff } from '../routes/WorkerDiff';
import { WorkerTerminal } from '../routes/WorkerTerminal';
import { SessionHeader } from '../shell/SessionHeader';
import { useSessions } from '../sessions/SessionsProvider';
import type { Tab } from './TabsProvider';

export function SessionPane({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  const { board, actions } = useSessions();
  const tile = useMemo(
    () => findTile(board.view?.groups ?? [], tab),
    [board.view, tab],
  );
  const isCodeWorker = tile?.kind === 'worker' && tile.type === 'code';
  const view = isCodeWorker ? tab.view : 'terminal';
  const [diffMounted, setDiffMounted] = useState(view === 'diff');

  useEffect(() => {
    if (view === 'diff') setDiffMounted(true);
  }, [view]);

  if (!tile) {
    return (
      <div className="hydra-session-missing">
        <h1>Session unavailable</h1>
        <p>The session may have been renamed or deleted. Choose another session from the sidebar.</p>
      </div>
    );
  }

  const stopped = tile.lifecycle === 'stopped';
  return (
    <div className="hydra-pane__inner">
      <SessionHeader tab={tab} tile={tile} />
      <div className="hydra-pane__body">
        <div className="hydra-pane__view" hidden={view !== 'terminal'}>
          {stopped ? (
            <StoppedSession tile={tile} onStart={() => actions.start(tile)} />
          ) : (
            <WorkerTerminal session={tile.session} active={active && view === 'terminal'} />
          )}
        </div>
        {isCodeWorker && diffMounted ? (
          <div className="hydra-pane__view" hidden={view !== 'diff'}>
            <WorkerDiff session={tile.session} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StoppedSession({ tile, onStart }: { tile: TileModel; onStart: () => void }): JSX.Element {
  return (
    <div className="hydra-stopped-session">
      <span className="hydra-stopped-session__label">Stopped</span>
      <h2>{tile.name}</h2>
      <p>{tile.agent} · {tile.workdir ?? 'Workdir unavailable'}</p>
      <button type="button" className="hydra-btn hydra-btn--primary" onClick={onStart}>
        Start {tile.kind === 'copilot' ? 'Copilot' : 'Worker'}
      </button>
    </div>
  );
}

function findTile(groups: readonly { readonly tiles: readonly TileModel[] }[], tab: Tab): TileModel | null {
  let routeFallback: TileModel | null = null;
  for (const group of groups) {
    for (const tile of group.tiles) {
      if (tab.sessionKind === 'worker' && tab.workerId !== undefined
        && tile.kind === 'worker' && tile.number === tab.workerId) {
        return tile;
      }
      if (tab.sessionKind === 'copilot' && tab.agentSessionId
        && tile.kind === 'copilot' && tile.raw.agentSessionId === tab.agentSessionId) {
        return tile;
      }
      if (tile.kind === tab.sessionKind && tile.session === tab.session) routeFallback = tile;
    }
  }
  return routeFallback;
}
