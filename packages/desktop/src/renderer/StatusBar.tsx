// StatusBar — the pinned bottom bar. A live/reconnecting pill plus the fleet
// counts (workers · copilots · unread · attention), read from the shared board.

import { useSessions } from './sessions/SessionsProvider';

export function StatusBar(): JSX.Element {
  const { board } = useSessions();
  const view = board.view;

  return (
    <footer className="hydra-statusbar">
      <span
        className={`hydra-statusbar__live hydra-statusbar__live--${board.connected ? 'on' : 'off'}`}
        title={`event seq ${board.lastSeq}`}
      >
        <span className="hydra-statusbar__dot" />
        {board.connected ? 'LIVE' : 'RECONNECTING…'}
      </span>

      {view ? (
        <span className="hydra-statusbar__counts">
          <Count value={view.workerCount} label="workers" />
          <Sep />
          <Count value={view.copilotCount} label="copilots" />
          <Sep />
          <Count value={view.unreadTotal} label="unread" tone={view.unreadTotal > 0 ? 'accent' : undefined} />
          <Sep />
          <Count
            value={view.attentionTotal}
            label="attention"
            tone={view.attentionTotal > 0 ? 'warn' : undefined}
          />
        </span>
      ) : (
        <span className="hydra-statusbar__counts hydra-muted">loading…</span>
      )}
    </footer>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone?: 'accent' | 'warn' }): JSX.Element {
  return (
    <span className={`hydra-statusbar__count${tone ? ` hydra-statusbar__count--${tone}` : ''}`}>
      <strong>{value}</strong> {label}
    </span>
  );
}

function Sep(): JSX.Element {
  return <span className="hydra-statusbar__sep" aria-hidden="true">·</span>;
}
