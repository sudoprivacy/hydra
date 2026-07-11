// One session row in the sidebar tree — a dense, two-line node that mirrors the
// old VS Code extension tree (packages/extension tmuxSessionProvider.ts).
//
//   Copilot:  ● name agent [N workers · M repos] ✓ 已完成   [unread] ⋮
//             35m ago
//   Worker:   ● branch #N agent running ✓ 已完成             [unread] ⋮
//             35m ago  U:2
//
// Clicking the row opens/focuses its tab when the session has an attachable
// terminal; the ⋮ menu carries the per-row actions. The row is highlighted when
// its tab is active.

import type { TileModel } from '../missionControl/boardModel';
import {
  COMPLETED_CHIP_LABEL,
  copilotSummaryLabel,
  gitChangeLabel,
  relativeTime,
  runtimeToken,
} from '../missionControl/format';
import { STATUS_LABELS, tileStatus } from '../status';
import { useTabs } from '../tabs/TabsProvider';
import { RowMenu } from './RowMenu';

export function TreeRow({ tile }: { tile: TileModel }): JSX.Element {
  const tabs = useTabs();
  const status = tileStatus(tile);
  const selected = tabs.activeSession === tile.session;

  const summary = tile.kind === 'copilot' ? copilotSummaryLabel(tile.workerCount, tile.repoCount) : null;
  const gitLabel = tile.kind === 'worker' ? gitChangeLabel(tile.changed) : null;
  const openTerminal = () => {
    tabs.openTab(tile.session, tile.kind, {
      workerId: tile.kind === 'worker' ? tile.number : undefined,
      agentSessionId: tile.raw.agentSessionId,
    });
  };

  return (
    <div
      className={`hydra-row${selected ? ' hydra-row--selected' : ''}`}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      title={tile.session}
      onClick={() => {
        openTerminal();
      }}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTerminal();
        }
      }}
    >
      <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
      <div className="hydra-row__main">
        <div className="hydra-row__line">
          <span className="hydra-row__name">{tile.name}</span>
          {tile.kind === 'worker' ? <span className="hydra-row__num">#{tile.number}</span> : null}
          <span className="hydra-row__agent">{tile.agent}</span>
          {tile.kind === 'worker' ? (
            <span className="hydra-row__token">{runtimeToken(tile.lifecycle, tile.runtime)}</span>
          ) : summary ? (
            <span className="hydra-row__summary">{summary}</span>
          ) : null}
          {tile.completed ? (
            <span className="hydra-chip hydra-chip--done" title="Task completed">
              {COMPLETED_CHIP_LABEL}
            </span>
          ) : null}
        </div>
        <div className="hydra-row__sub">
          <span className="hydra-row__time">{relativeTime(tile.lastEventAt)}</span>
          {gitLabel ? (
            <span className="hydra-row__u" title="changed files (git status)">
              {gitLabel}
            </span>
          ) : null}
        </div>
      </div>
      {tile.unread > 0 ? (
        <span
          className="hydra-row__unread hydra-badge hydra-badge--unread"
          title={`${tile.unread} unread`}
        >
          {tile.unread}
        </span>
      ) : null}
      <RowMenu tile={tile} />
    </div>
  );
}
