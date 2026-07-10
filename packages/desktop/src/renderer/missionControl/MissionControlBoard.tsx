// The board layout: a command bar plus repo / Local Tasks / Copilots groups of
// tiles. Purely presentational — it renders the BoardView the hook derived and
// forwards every action to the container. No client, no streams here.

import type { BoardGroup, BoardView } from './boardModel';
import type { CreateKind } from './CreateSessionModal';
import { SessionTile, type TileActions } from './SessionTile';

export interface MissionControlBoardProps {
  view: BoardView;
  connected: boolean;
  lastSeq: number;
  onRefresh: () => void;
  onCreate: (kind: CreateKind) => void;
  onBroadcast: () => void;
  onRestore: () => void;
  tileActions: TileActions;
}

export function MissionControlBoard({
  view,
  connected,
  lastSeq,
  onRefresh,
  onCreate,
  onBroadcast,
  onRestore,
  tileActions,
}: MissionControlBoardProps): JSX.Element {
  return (
    <section className="hydra-board">
      <header className="hydra-board__bar">
        <div className="hydra-board__heading">
          <h1>Mission Control</h1>
          <span className={`hydra-live hydra-live--${connected ? 'on' : 'off'}`} title={`seq ${lastSeq}`}>
            <span className="hydra-live__dot" />
            {connected ? 'live' : 'reconnecting…'}
          </span>
        </div>

        <div className="hydra-board__stats">
          <Stat label="workers" value={view.workerCount} />
          <Stat label="copilots" value={view.copilotCount} />
          <Stat label="unread" value={view.unreadTotal} tone={view.unreadTotal > 0 ? 'accent' : undefined} />
          <Stat
            label="attention"
            value={view.attentionTotal}
            tone={view.attentionTotal > 0 ? 'warn' : undefined}
          />
        </div>

        <div className="hydra-board__actions">
          <button type="button" className="hydra-btn hydra-btn--primary" onClick={() => onCreate('worker')}>
            + Worker
          </button>
          <button type="button" className="hydra-btn" onClick={() => onCreate('copilot')}>
            + Copilot
          </button>
          <button type="button" className="hydra-btn" onClick={onBroadcast}>
            Broadcast
          </button>
          <button type="button" className="hydra-btn" onClick={onRestore}>
            Restore…
          </button>
          <button type="button" className="hydra-btn" onClick={onRefresh} title="Re-sync listSessions()">
            ↻
          </button>
        </div>
      </header>

      {view.groups.length === 0 ? (
        <div className="hydra-board__empty">
          <p>No sessions yet.</p>
          <p className="hydra-muted">Create a worker or a copilot to get started.</p>
        </div>
      ) : (
        <div className="hydra-board__groups">
          {view.groups.map((group) => (
            <GroupSection key={group.key} group={group} tileActions={tileActions} />
          ))}
        </div>
      )}
    </section>
  );
}

function GroupSection({ group, tileActions }: { group: BoardGroup; tileActions: TileActions }): JSX.Element {
  return (
    <section className="hydra-group">
      <header className="hydra-group__head">
        <h2 className="hydra-group__title">
          <GroupIcon kind={group.kind} /> {group.label}
        </h2>
        <span className="hydra-group__count">{group.tiles.length}</span>
        {group.attentionCount > 0 ? (
          <span className="hydra-badge hydra-badge--warn" title="tiles needing input / in error">
            {group.attentionCount} needs attention
          </span>
        ) : null}
        {group.unreadCount > 0 ? (
          <span className="hydra-badge hydra-badge--unread" title="unread notifications">
            {group.unreadCount}
          </span>
        ) : null}
      </header>
      <div className="hydra-group__grid">
        {group.tiles.map((tile) => (
          <SessionTile key={tile.session} tile={tile} actions={tileActions} />
        ))}
      </div>
    </section>
  );
}

function GroupIcon({ kind }: { kind: BoardGroup['kind'] }): JSX.Element {
  return <span className={`hydra-group__icon hydra-group__icon--${kind}`} aria-hidden="true" />;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'accent' | 'warn' }): JSX.Element {
  return (
    <span className={`hydra-stat${tone ? ` hydra-stat--${tone}` : ''}`}>
      <span className="hydra-stat__value">{value}</span>
      <span className="hydra-stat__label">{label}</span>
    </span>
  );
}
