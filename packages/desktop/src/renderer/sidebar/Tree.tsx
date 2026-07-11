import { useState, type ReactNode } from 'react';

import type { DesktopControlView, WorkerControlGroup } from '../controlState/selectors';
import { ChevronRight, Folder } from '../ui/icons';
import { filterSidebarView } from './sidebarFilter';
import { TreeRow } from './TreeRow';

export function Tree({ view, query }: { view: DesktopControlView; query: string }): JSX.Element {
  const filtered = filterSidebarView(view, query);
  const { copilots, workerGroups } = filtered;
  const repositories = workerGroups.filter(group => group.kind === 'repository');
  const localTasks = workerGroups.find(group => group.kind === 'local-tasks');

  return (
    <div className="hydra-tree" role="tree">
      <TreeSection title="COPILOTS" count={copilots.length}>
        {copilots.length > 0
          ? copilots.map(copilot => <TreeRow key={copilot.session} row={copilot} />)
          : <p className="hydra-tree__empty">{filtered.query ? 'No matching Copilots' : 'No Copilots'}</p>}
      </TreeSection>

      <TreeSection title="WORKERS" count={workerGroups.reduce((sum, group) => sum + group.workers.length, 0)}>
        {repositories.length > 0 ? (
          <TreeSubsection label="REPOSITORIES">
            {repositories.map(group => <WorkerGroup key={group.key} group={group} />)}
          </TreeSubsection>
        ) : null}
        {localTasks ? (
          <TreeSubsection label="LOCAL TASKS">
            <WorkerGroup group={localTasks} showHeading={false} />
          </TreeSubsection>
        ) : null}
        {workerGroups.length === 0 ? (
          <p className="hydra-tree__empty">{filtered.query ? 'No matching Workers' : 'No Workers'}</p>
        ) : null}
      </TreeSection>

      {filtered.noMatches ? <p className="hydra-tree__search-empty">No sessions match “{query.trim()}”.</p> : null}
    </div>
  );
}

function TreeSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <section className="hydra-tree__section" aria-label={`${title}, ${count}`}>
      <button
        type="button"
        className="hydra-tree__head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span className="hydra-tree__title">{title}</span>
      </button>
      {open ? <div className="hydra-tree__body" role="group">{children}</div> : null}
    </section>
  );
}

function TreeSubsection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="hydra-tree__subsection">
      <span className="hydra-tree__subtitle">{label}</span>
      {children}
    </div>
  );
}

function WorkerGroup({
  group,
  showHeading = true,
}: {
  group: WorkerControlGroup;
  showHeading?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  if (!showHeading) {
    return (
      <div className="hydra-repo__body hydra-repo__body--local">
        {group.workers.map(worker => <TreeRow key={worker.workerId} row={worker} />)}
      </div>
    );
  }
  return (
    <div className="hydra-repo">
      <button
        type="button"
        className="hydra-repo__head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Caret open={open} />
        <Folder size={14} strokeWidth={1.6} aria-hidden="true" />
        <span className="hydra-repo__label">{group.label}</span>
      </button>
      {open ? (
        <div className="hydra-repo__body" role="group">
          {group.workers.map(worker => <TreeRow key={worker.workerId} row={worker} />)}
        </div>
      ) : null}
    </div>
  );
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <ChevronRight
      className={`hydra-caret${open ? ' hydra-caret--open' : ''}`}
      size={13}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}
