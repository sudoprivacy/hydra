import { useEffect, useMemo, useState } from 'react';

import type { SessionControlRow } from '../controlState/selectors';
import { WorkerDiff } from '../routes/WorkerDiff';
import { WorkerTerminal } from '../routes/WorkerTerminal';
import { SessionHeader } from '../shell/SessionHeader';
import { useSessions } from '../sessions/SessionsProvider';
import { useTabs, type Tab } from './TabsProvider';
import { selectTabSession } from './tabSelectors';

export function SessionPane({ tab, active }: { tab: Tab; active: boolean }): JSX.Element {
  const tabs = useTabs();
  const { control, actions } = useSessions();
  const row = useMemo(() => selectTabSession(control.view, tab), [control.view, tab]);
  const isCodeWorker = row?.kind === 'worker' && row.type === 'code';
  const terminalAvailable = Boolean(row && row.lifecycle !== 'stopped');
  const view = isCodeWorker && !terminalAvailable ? 'diff' : isCodeWorker ? tab.view : 'terminal';
  const [diffMounted, setDiffMounted] = useState(view === 'diff');

  useEffect(() => {
    if (view === 'diff') setDiffMounted(true);
  }, [view]);

  useEffect(() => {
    if (isCodeWorker && !terminalAvailable && tab.view !== 'diff') {
      tabs.setView(tab.id, 'diff');
    }
  }, [isCodeWorker, tab.id, tab.view, tabs, terminalAvailable]);

  if (!row) {
    return (
      <div className="hydra-session-missing">
        <h1>Session unavailable</h1>
        <p>The session may have been renamed or deleted. Choose another session from the sidebar.</p>
      </div>
    );
  }

  const stopped = !terminalAvailable;
  const terminalIdentity = buildTerminalIdentity(row);
  return (
    <div className="hydra-pane__inner">
      <SessionHeader tab={tab} row={row} />
      <div className="hydra-pane__body">
        <div className="hydra-pane__view" hidden={view !== 'terminal'}>
          {stopped ? (
            <StoppedSession row={row} onStart={() => actions.start(row)} />
          ) : (
            <WorkerTerminal
              session={row.session}
              active={active && view === 'terminal'}
              identity={terminalIdentity.label}
              identityTitle={terminalIdentity.title}
            />
          )}
        </div>
        {isCodeWorker && diffMounted ? (
          <div className="hydra-pane__view" hidden={view !== 'diff'}>
            <WorkerDiff session={row.session} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function buildTerminalIdentity(row: SessionControlRow): { label: string; title: string } {
  if (row.kind === 'copilot') {
    const label = ['COPILOT', row.workdir || 'home folder'].join(' · ');
    return { label, title: `${label}\n${row.session}` };
  }
  if (row.type === 'task') {
    const folderType = row.raw.managedWorkdir ? 'managed folder' : 'folder';
    const label = ['TASK', folderType, row.workdir || row.name].join(' · ');
    return { label, title: `${label}\n${row.session}` };
  }
  const label = ['CODE', row.repoLabel, row.branch, row.workdir].filter(Boolean).join(' · ');
  return { label, title: `${label}\n${row.session}` };
}

function StoppedSession({
  row,
  onStart,
}: {
  row: SessionControlRow;
  onStart: () => void;
}): JSX.Element {
  return (
    <div className="hydra-stopped-session">
      <span className="hydra-stopped-session__label">Stopped</span>
      <h2>{row.name}</h2>
      <p>{row.agent} · {row.workdir ?? 'Workdir unavailable'}</p>
      <button type="button" className="hydra-btn hydra-btn--primary" onClick={onStart}>
        Start {row.kind === 'copilot' ? 'Copilot' : 'Worker'}
      </button>
    </div>
  );
}
