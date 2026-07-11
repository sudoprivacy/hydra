import { useState, type ReactNode } from 'react';

import type { BoardGroup, BoardView } from '../missionControl/boardModel';
import { TreeRow } from './TreeRow';

export function Tree({ view }: { view: BoardView }): JSX.Element {
  const copilots = view.groups.find(group => group.kind === 'copilots');
  const repositories = view.groups.filter(group => group.kind === 'repo');
  const localTasks = view.groups.find(group => group.kind === 'tasks');

  return (
    <div className="hydra-tree" role="tree">
      <TreeSection title="COPILOTS" count={view.copilotCount}>
        {copilots && copilots.tiles.length > 0
          ? copilots.tiles.map(tile => <TreeRow key={tile.session} tile={tile} />)
          : <p className="hydra-tree__empty">No copilots</p>}
      </TreeSection>

      <TreeSection title="WORKERS" count={view.workerCount}>
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
        {repositories.length === 0 && !localTasks ? <p className="hydra-tree__empty">No workers</p> : null}
      </TreeSection>
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
    <section className="hydra-tree__section">
      <button
        type="button"
        className="hydra-tree__head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Caret open={open} />
        <span className="hydra-tree__title">{title}</span>
        <span className="hydra-tree__count">{count}</span>
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

function WorkerGroup({ group, showHeading = true }: { group: BoardGroup; showHeading?: boolean }): JSX.Element {
  const [open, setOpen] = useState(true);
  if (!showHeading) {
    return <div className="hydra-repo__body">{group.tiles.map(tile => <TreeRow key={tile.session} tile={tile} />)}</div>;
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
        <span className="hydra-repo__label">{group.label}</span>
        <span className="hydra-tree__count">{group.tiles.length}</span>
      </button>
      {open ? (
        <div className="hydra-repo__body" role="group">
          {group.tiles.map(tile => <TreeRow key={tile.session} tile={tile} />)}
        </div>
      ) : null}
    </div>
  );
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return <span className={`hydra-caret${open ? ' hydra-caret--open' : ''}`} aria-hidden="true">▸</span>;
}
