// One board tile — a worker or a copilot. Presentational: it renders the model
// the reducer produced and calls back to the container for every mutation.
// Opening a tile hands off to the tab shell (`onOpen`): any session can open a
// terminal; only workers can open a diff (copilots have no branch/worktree).

import type { CopilotTileModel, TileModel, WorkerTileModel } from './boardModel';
import { lifecycleLabel, relativeTime, runtimeLabel, runtimeModifier } from './format';

export interface TileActions {
  onOpen: (tile: TileModel, view: 'terminal' | 'diff') => void;
  onSend: (tile: TileModel) => void;
  onRename: (tile: TileModel) => void;
  onDelete: (tile: TileModel) => void;
  onStart: (tile: TileModel) => void;
  onStop: (tile: WorkerTileModel) => void;
}

export function SessionTile({ tile, actions }: { tile: TileModel; actions: TileActions }): JSX.Element {
  return tile.kind === 'worker' ? (
    <WorkerTile tile={tile} actions={actions} />
  ) : (
    <CopilotTile tile={tile} actions={actions} />
  );
}

function WorkerTile({ tile, actions }: { tile: WorkerTileModel; actions: TileActions }): JSX.Element {
  const detail = [tile.type === 'code' ? tile.branch : 'task', tile.agent].filter(Boolean).join(' · ');

  return (
    <article className={`hydra-tile hydra-tile--${tile.lifecycle}`} data-session={tile.session}>
      <div className="hydra-tile__top">
        <span className="hydra-tile__number">#{tile.number}</span>
        <span className="hydra-tile__name" title={tile.session}>
          {tile.name}
        </span>
        <StatusBadges tile={tile} />
      </div>

      <div className="hydra-tile__detail" title={tile.workdir ?? undefined}>
        {detail || tile.session}
      </div>
      {tile.copilotSessionName ? (
        <div className="hydra-tile__sub">copilot: {tile.copilotSessionName}</div>
      ) : null}

      <div className="hydra-tile__foot">
        <span className="hydra-tile__time">{relativeTime(tile.lastEventAt)}</span>
        {tile.runtimeReason ? <span className="hydra-tile__reason">{tile.runtimeReason}</span> : null}
      </div>

      <div className="hydra-tile__actions">
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onOpen(tile, 'terminal')}>
          terminal
        </button>
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onOpen(tile, 'diff')}>
          diff
        </button>
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onSend(tile)}>
          send
        </button>
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onRename(tile)}>
          rename
        </button>
        {tile.lifecycle === 'running' ? (
          <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onStop(tile)}>
            stop
          </button>
        ) : (
          <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onStart(tile)}>
            start
          </button>
        )}
        <button
          type="button"
          className="hydra-btn hydra-btn--sm hydra-btn--danger"
          onClick={() => actions.onDelete(tile)}
        >
          delete
        </button>
      </div>
    </article>
  );
}

function CopilotTile({ tile, actions }: { tile: CopilotTileModel; actions: TileActions }): JSX.Element {
  return (
    <article className={`hydra-tile hydra-tile--copilot hydra-tile--${tile.lifecycle}`} data-session={tile.session}>
      <div className="hydra-tile__top">
        <span className="hydra-tile__name" title={tile.session}>
          {tile.name}
        </span>
        <span className="hydra-chip">copilot</span>
        {tile.mode === 'plan' ? <span className="hydra-chip hydra-chip--plan">plan</span> : null}
        <span className={`hydra-dot hydra-dot--${tile.lifecycle}`} title={lifecycleLabel(tile.lifecycle)} />
        {tile.unread > 0 ? <span className="hydra-badge hydra-badge--unread">{tile.unread}</span> : null}
      </div>

      <div className="hydra-tile__detail" title={tile.workdir ?? undefined}>
        {tile.agent}
        {tile.workdir ? ` · ${tile.workdir}` : ''}
      </div>

      <div className="hydra-tile__foot">
        <span className="hydra-tile__time">{relativeTime(tile.lastEventAt)}</span>
      </div>

      <div className="hydra-tile__actions">
        {tile.lifecycle !== 'stopped' ? (
          <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onOpen(tile, 'terminal')}>
            terminal
          </button>
        ) : null}
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onSend(tile)}>
          send
        </button>
        <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onRename(tile)}>
          rename
        </button>
        {tile.lifecycle === 'stopped' ? (
          <button type="button" className="hydra-btn hydra-btn--sm" onClick={() => actions.onStart(tile)}>
            start
          </button>
        ) : null}
        <button
          type="button"
          className="hydra-btn hydra-btn--sm hydra-btn--danger"
          onClick={() => actions.onDelete(tile)}
        >
          delete
        </button>
      </div>
    </article>
  );
}

function StatusBadges({ tile }: { tile: WorkerTileModel }): JSX.Element {
  return (
    <span className="hydra-tile__badges">
      <span
        className={`hydra-runtime hydra-runtime--${runtimeModifier(tile.runtime)}`}
        title={`runtime: ${runtimeLabel(tile.runtime)}`}
      >
        {runtimeLabel(tile.runtime)}
      </span>
      <span className={`hydra-dot hydra-dot--${tile.lifecycle}`} title={lifecycleLabel(tile.lifecycle)} />
      {tile.unread > 0 ? <span className="hydra-badge hydra-badge--unread">{tile.unread}</span> : null}
    </span>
  );
}
