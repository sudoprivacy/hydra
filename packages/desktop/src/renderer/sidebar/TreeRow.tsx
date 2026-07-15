import type { SessionControlRow } from '../controlState/selectors';
import {
  copilotSummaryLabel,
  gitChangeLabel,
} from '../missionControl/format';
import { controlRowStatus, STATUS_LABELS } from '../status';
import { useTabs } from '../tabs/TabsProvider';
import { GitBranch } from '../ui/icons';
import { RowMenu } from './RowMenu';
import { treeRowIconName } from './rowIcon';

export function TreeRow({ row }: { row: SessionControlRow }): JSX.Element {
  const tabs = useTabs();
  const status = controlRowStatus(row);
  const rowIcon = treeRowIconName(row);
  const selected = tabs.activeSession === row.session;
  const summary = row.kind === 'copilot'
    ? copilotSummaryLabel(row.workerCount, row.repoCount)
    : null;
  const gitLabel = row.kind === 'worker' ? gitChangeLabel(row.changed) : null;
  const attentionBadge = row.kind === 'copilot'
    ? row.activeAttentionCount
    : row.activeAttentionCount > 1 ? row.activeAttentionCount : 0;
  const showLifecycleDot = row.kind === 'worker' || status !== 'running';
  const canOpen = row.lifecycle === 'running' || (row.kind === 'worker' && row.type === 'code');
  const preferredView = row.lifecycle === 'stopped' ? 'diff' : 'terminal';
  const openPreferredView = () => {
    if (!canOpen) return;
    tabs.openTab(row.session, row.kind, {
      workerId: row.kind === 'worker' ? row.workerId : undefined,
      agentSessionId: row.raw.agentSessionId,
      view: preferredView,
    });
  };

  return (
    <div
      className={`hydra-row hydra-row--${row.kind}${selected ? ' hydra-row--selected' : ''}`}
      role="treeitem"
      aria-selected={selected}
      aria-disabled={!canOpen || undefined}
      tabIndex={canOpen ? 0 : -1}
      title={row.session}
      onClick={openPreferredView}
      onKeyDown={event => {
        if (event.currentTarget !== event.target) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPreferredView();
        }
      }}
    >
      {rowIcon ? (
        <span className="hydra-row__icon" aria-hidden="true">
          <GitBranch size={row.kind === 'copilot' ? 17 : 15} strokeWidth={1.55} />
        </span>
      ) : null}
      <div className="hydra-row__main">
        <div className="hydra-row__line">
          <span className="hydra-row__name">{row.name}</span>
          {gitLabel ? <span className="hydra-row__changes" title={`${gitLabel} changed files`}>{gitLabel}</span> : null}
        </div>
        {summary ? (
          <div className="hydra-row__sub">
            <span className="hydra-row__summary">{summary}</span>
          </div>
        ) : null}
      </div>
      {attentionBadge > 0 ? (
        <span
          className="hydra-row__unread hydra-badge hydra-badge--unread"
          title={`${row.activeAttentionCount} active attention occurrences`}
        >
          {attentionBadge}
        </span>
      ) : null}
      {showLifecycleDot ? (
        <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
      ) : null}
      <RowMenu row={row} />
    </div>
  );
}
