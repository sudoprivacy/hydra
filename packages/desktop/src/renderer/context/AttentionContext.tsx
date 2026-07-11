import type { HydraNotificationV2 } from '@hydra/protocol';

import type { AttentionControlRow, WorkerControlRow } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import { GitCompareArrows, Terminal, X } from '../ui/icons';
import {
  ContextSection,
  formatObservedAt,
  occurrenceKindLabel,
} from './ContextPrimitives';

export interface AttentionHistoryRow {
  readonly occurrence: HydraNotificationV2;
  readonly worker: WorkerControlRow | null;
}

export function AttentionContext({
  rows,
  history,
  showHistory,
  historyLoading,
  historyError,
  onSetHistory,
  onRoute,
}: {
  rows: readonly AttentionControlRow[];
  history: readonly AttentionHistoryRow[];
  showHistory: boolean;
  historyLoading: boolean;
  historyError: string | null;
  onSetHistory: (show: boolean) => void;
  onRoute: (occurrence: HydraNotificationV2, worker: WorkerControlRow | null) => void;
}): JSX.Element {
  const { actions } = useSessions();
  return (
    <>
      <div className="hydra-context__attention-switch" role="tablist" aria-label="Attention scope">
        <ScopeButton label="Active" active={!showHistory} onClick={() => onSetHistory(false)} />
        <ScopeButton label="History" active={showHistory} onClick={() => onSetHistory(true)} />
      </div>

      {showHistory ? (
        <ContextSection title="Attention history">
          {historyLoading ? <p className="hydra-context__empty">Loading history…</p> : null}
          {historyError ? <p className="hydra-context__error">{historyError}</p> : null}
          {!historyLoading && !historyError && history.length === 0 ? (
            <p className="hydra-context__empty">No resolved or dismissed occurrences.</p>
          ) : null}
          <div className="hydra-context__attention-list">
            {history.map(row => (
              <article key={row.occurrence.occurrenceId} className="hydra-context__history-row">
                <div className="hydra-context__attention-meta">
                  <span>{occurrenceKindLabel(row.occurrence.kind)}</span>
                  <span>{row.occurrence.status}</span>
                  <time>{formatObservedAt(historyTimestamp(row.occurrence))}</time>
                </div>
                <strong>{row.worker?.name ?? row.occurrence.sourceSession}</strong>
                <span>{row.occurrence.title}</span>
              </article>
            ))}
          </div>
        </ContextSection>
      ) : (
        <ContextSection title="Active attention">
          {rows.length === 0 ? <p className="hydra-context__empty">Nothing needs attention.</p> : null}
          <div className="hydra-context__attention-list">
            {rows.map(row => {
              const routeLabel = row.occurrence.kind === 'complete' && row.worker?.type === 'code'
                ? 'Review Diff'
                : 'Open Terminal';
              return (
                <article
                  key={row.occurrence.occurrenceId}
                  className={`hydra-context__attention-row hydra-context__attention-row--${row.occurrence.kind}`}
                >
                  <div className="hydra-context__attention-meta">
                    <span>{occurrenceKindLabel(row.occurrence.kind)}</span>
                    <time>{formatObservedAt(row.occurrence.createdAt)}</time>
                  </div>
                  <strong>{row.worker?.name ?? row.occurrence.sourceSession}</strong>
                  <span className="hydra-context__attention-title">{row.occurrence.title}</span>
                  {row.occurrence.body ? <p>{row.occurrence.body}</p> : null}
                  <div className="hydra-context__attention-actions">
                    <button
                      type="button"
                      className="hydra-btn hydra-btn--primary"
                      disabled={!row.worker}
                      onClick={() => onRoute(row.occurrence, row.worker)}
                    >
                      {row.occurrence.kind === 'complete' && row.worker?.type === 'code'
                        ? <GitCompareArrows size={13} aria-hidden="true" />
                        : <Terminal size={13} aria-hidden="true" />}
                      {row.worker ? routeLabel : 'Worker unavailable'}
                    </button>
                    <button
                      type="button"
                      className="hydra-btn"
                      onClick={() => actions.dismissNotification(row.occurrence.id)}
                    >
                      <X size={13} aria-hidden="true" />
                      Dismiss
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </ContextSection>
      )}
    </>
  );
}

function ScopeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'hydra-context__scope--active' : ''}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function historyTimestamp(occurrence: HydraNotificationV2): string {
  return occurrence.dismissedAt ?? occurrence.resolvedAt ?? occurrence.createdAt;
}
