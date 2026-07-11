import type { TileModel } from '../missionControl/boardModel';
import { STATUS_LABELS, tileStatus } from '../status';
import { useSessions } from '../sessions/SessionsProvider';
import { useShellUi } from './shellState';
import { useTabs, type Tab, type TabView } from '../tabs/TabsProvider';
import { useContextUi } from '../context/ContextState';

export function SessionHeader({ tab, tile }: { tab: Tab; tile: TileModel }): JSX.Element {
  const tabs = useTabs();
  const { control } = useSessions();
  const shell = useShellUi();
  const contextUi = useContextUi();
  const status = tileStatus(tile);
  const isCodeWorker = tile.kind === 'worker' && tile.type === 'code';
  const view: TabView = isCodeWorker ? tab.view : 'terminal';
  const activeAttentionCount = tab.sessionKind === 'worker'
    ? control.view?.workers.find(worker => (
      tab.workerId !== undefined ? worker.workerId === tab.workerId : worker.session === tile.session
    ))?.activeAttentionCount ?? 0
    : control.view?.copilots.find(copilot => copilot.session === tile.session)?.activeAttentionCount ?? 0;

  return (
    <header className="hydra-session-header">
      <div className="hydra-session-header__identity">
        <div className="hydra-session-header__titleline">
          <h1 title={tile.name}>{tile.name}</h1>
          <span className={`hydra-sdot hydra-sdot--${status}`} aria-hidden="true" />
          <span className="hydra-session-header__status">{STATUS_LABELS[status]}</span>
          {!control.connected ? <span className="hydra-session-header__connection">Reconnecting…</span> : null}
        </div>
        <code className="hydra-session-header__session" title={tile.session}>{tile.session}</code>
      </div>

      {isCodeWorker ? (
        <div className="hydra-seg-toggle" role="tablist" aria-label="Worker view">
          <HeaderToggle label="Terminal" active={view === 'terminal'} onClick={() => tabs.setView(tab.id, 'terminal')} />
          <HeaderToggle label="Diff" active={view === 'diff'} onClick={() => tabs.setView(tab.id, 'diff')} />
        </div>
      ) : null}

      {!shell.terminalMaximized ? (
        <button
          type="button"
          className={`hydra-session-header__utility${
            contextUi.isOpenFor(tab.sessionKind, tile.session) ? ' hydra-session-header__utility--active' : ''
          }`}
          aria-pressed={contextUi.isOpenFor(tab.sessionKind, tile.session)}
          onClick={() => contextUi.toggleForSession(tab.sessionKind, tile.session)}
        >
          Context
          {activeAttentionCount > 0 ? (
            <span className="hydra-session-header__count">{activeAttentionCount}</span>
          ) : null}
        </button>
      ) : null}

      {shell.terminalMaximized ? (
        <button type="button" className="hydra-session-header__utility" onClick={shell.restoreTerminal}>
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
