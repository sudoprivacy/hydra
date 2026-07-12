import { Children, useState, type ReactNode } from 'react';

import type { DesktopControlView, WorkerControlGroup } from '../controlState/selectors';
import { ChevronRight, Folder } from '../ui/icons';
import { discloseRows } from './disclosure';
import { filterSidebarView } from './sidebarFilter';
import { TreeRow } from './TreeRow';

const COLLAPSED_COPILOT_LIMIT = 5;
const COLLAPSED_LOCAL_TASK_LIMIT = 4;

export function Tree({ view, query }: { view: DesktopControlView; query: string }): JSX.Element {
  const filtered = filterSidebarView(view, query);
  const { copilots, workerGroups } = filtered;
  const repositories = workerGroups.filter(group => group.kind === 'repository');
  const localTasks = workerGroups.find(group => group.kind === 'local-tasks');
  const filtering = filtered.query.length > 0;

  return (
    <div className="hydra-tree" role="tree">
      <TreeSection title="COPILOTS" count={copilots.length} forceOpen={filtering}>
        {copilots.length > 0
          ? (
            <RowDisclosure limit={COLLAPSED_COPILOT_LIMIT} forceExpanded={filtering}>
              {copilots.map(copilot => <TreeRow key={copilot.session} row={copilot} />)}
            </RowDisclosure>
          )
          : <p className="hydra-tree__empty">{filtered.query ? 'No matching Copilots' : 'No Copilots'}</p>}
      </TreeSection>

      <TreeSection
        title="WORKERS"
        count={workerGroups.reduce((sum, group) => sum + group.workers.length, 0)}
        forceOpen={filtering}
      >
        {repositories.length > 0 ? (
          <TreeSubsection label="REPOSITORIES">
            {repositories.map(group => <WorkerGroup key={group.key} group={group} />)}
          </TreeSubsection>
        ) : null}
        {localTasks ? (
          <TreeSubsection label="LOCAL TASKS" collapsible forceOpen={filtering}>
            <WorkerGroup
              group={localTasks}
              showHeading={false}
              limit={COLLAPSED_LOCAL_TASK_LIMIT}
              forceExpanded={filtering}
            />
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
  forceOpen = false,
}: {
  title: string;
  count: number;
  children: ReactNode;
  forceOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const expanded = forceOpen || open;
  return (
    <section className="hydra-tree__section" aria-label={`${title}, ${count}`}>
      <button
        type="button"
        className="hydra-tree__head"
        aria-expanded={expanded}
        onClick={() => setOpen(value => !value)}
      >
        <Caret open={expanded} />
        <span className="hydra-tree__title">{title}</span>
      </button>
      {expanded ? <div className="hydra-tree__body" role="group">{children}</div> : null}
    </section>
  );
}

function TreeSubsection({
  label,
  children,
  collapsible = false,
  forceOpen = false,
}: {
  label: string;
  children: ReactNode;
  collapsible?: boolean;
  forceOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const expanded = forceOpen || open;
  return (
    <div className="hydra-tree__subsection">
      {collapsible ? (
        <button
          type="button"
          className="hydra-tree__subhead"
          aria-expanded={expanded}
          onClick={() => setOpen(value => !value)}
        >
          <Caret open={expanded} />
          <span className="hydra-tree__subtitle">{label}</span>
        </button>
      ) : <span className="hydra-tree__subtitle">{label}</span>}
      {expanded ? children : null}
    </div>
  );
}

function WorkerGroup({
  group,
  showHeading = true,
  limit,
  forceExpanded = false,
}: {
  group: WorkerControlGroup;
  showHeading?: boolean;
  limit?: number;
  forceExpanded?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  if (!showHeading) {
    return (
      <div className="hydra-repo__body hydra-repo__body--local">
        <RowDisclosure limit={limit} forceExpanded={forceExpanded}>
          {group.workers.map(worker => <TreeRow key={worker.workerId} row={worker} />)}
        </RowDisclosure>
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

function RowDisclosure({
  children,
  limit,
  forceExpanded = false,
}: {
  children: ReactNode;
  limit?: number;
  forceExpanded?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const rows = Children.toArray(children);
  const disclosure = discloseRows(
    rows,
    limit ?? rows.length,
    expanded,
    forceExpanded,
  );
  return (
    <>
      {disclosure.visible}
      {disclosure.canToggle ? (
        <button
          type="button"
          className="hydra-tree__disclosure"
          aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer sessions' : `Show ${disclosure.hiddenCount} more sessions`}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
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
