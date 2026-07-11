import type { SessionControlRow } from '../controlState/selectors';
import { useContextUi } from '../context/ContextState';
import { controlRowStatus, STATUS_LABELS } from '../status';
import { useTabs, type Tab, type TabView } from '../tabs/TabsProvider';
import { ListFilter, SquarePen } from '../ui/icons';
import { useSessions } from '../sessions/SessionsProvider';
import { useShellUi } from './shellState';
import { RowMenu } from '../sidebar/RowMenu';

export function SessionHeader({ tab, row }: { tab: Tab; row: SessionControlRow }): JSX.Element {
  const tabs = useTabs();
  const { control } = useSessions();
  const shell = useShellUi();
  const contextUi = useContextUi();
  const status = controlRowStatus(row);
  const isCodeWorker = row.kind === 'worker' && row.type === 'code';
  const view: TabView = isCodeWorker ? tab.view : 'terminal';

  return (
    <header className="hydra-session-header">
      <div className="hydra-session-header__identity">
        <div className="hydra-session-header__titleline">
          <h1 title={row.name}>{row.name}</h1>
          <span className={`hydra-sdot hydra-sdot--${status}`} aria-hidden="true" />
          <span className="hydra-session-header__status">{status === 'running' ? 'Live' : STATUS_LABELS[status]}</span>
          <span className="hydra-session-header__separator" aria-hidden="true">•</span>
          <span className="hydra-session-header__session" title={row.session}>Session: {row.session}</span>
          {!control.connected ? <span className="hydra-session-header__connection">Reconnecting…</span> : null}
        </div>
      </div>

      {isCodeWorker ? (
        <div className="hydra-seg-toggle" role="tablist" aria-label="Worker view">
          <HeaderToggle label="Terminal" active={view === 'terminal'} onClick={() => tabs.setView(tab.id, 'terminal')} />
          <HeaderToggle label="Diff" active={view === 'diff'} onClick={() => tabs.setView(tab.id, 'diff')} />
        </div>
      ) : null}

      {!shell.terminalMaximized ? (
        <div className="hydra-session-header__actions">
          <button
            type="button"
            className="hydra-session-header__utility"
            aria-label="Open attention"
            title="Open attention"
            aria-pressed={contextUi.open && contextUi.mode === 'attention'}
            onClick={contextUi.openAttention}
          >
            <ListFilter size={15} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`hydra-session-header__utility hydra-session-header__utility--context${
              contextUi.isOpenFor(tab.sessionKind, row.session) ? ' hydra-session-header__utility--active' : ''
            }`}
            aria-label="Toggle context"
            title="Toggle context"
            aria-pressed={contextUi.isOpenFor(tab.sessionKind, row.session)}
            onClick={() => contextUi.toggleForSession(tab.sessionKind, row.session)}
          >
            <SquarePen size={15} strokeWidth={1.65} aria-hidden="true" />
            {row.activeAttentionCount > 0 ? <span className="hydra-session-header__attention-dot" /> : null}
          </button>
          <div className="hydra-session-header__more"><RowMenu row={row} /></div>
        </div>
      ) : null}

      {shell.terminalMaximized ? (
        <button type="button" className="hydra-session-header__utility hydra-session-header__utility--text" onClick={shell.restoreTerminal}>
          Restore layout
        </button>
      ) : null}
    </header>
  );
}

function HeaderToggle({
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
      className={`hydra-seg-toggle__btn${active ? ' hydra-seg-toggle__btn--active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
