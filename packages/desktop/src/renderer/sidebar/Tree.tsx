// The session tree: a COPILOTS section (flat) and a WORKERS section (grouped by
// repo, then Local Tasks). Both sections and every repo group are collapsible.
// The grouping is taken straight from the board view the reducer already
// produces — this file only reshapes it into the two top-level sections.

import { useState, type ReactNode } from 'react';

import type { BoardGroup, BoardView } from '../missionControl/boardModel';
import { TreeRow } from './TreeRow';

export function Tree({ view }: { view: BoardView }): JSX.Element {
  const copilots = view.groups.find((group) => group.kind === 'copilots');
  const workerGroups = view.groups.filter((group) => group.kind === 'repo' || group.kind === 'tasks');

  return (
    <div className="hydra-tree" role="tree">
      <TreeSection title="COPILOTS" count={view.copilotCount}>
        {copilots && copilots.tiles.length > 0 ? (
          copilots.tiles.map((tile) => <TreeRow key={tile.session} tile={tile} />)
        ) : (
          <p className="hydra-tree__empty">No copilots</p>
        )}
      </TreeSection>

      <TreeSection title="WORKERS" count={view.workerCount}>
        {workerGroups.length > 0 ? (
          workerGroups.map((group) => <RepoGroup key={group.key} group={group} />)
        ) : (
          <p className="hydra-tree__empty">No workers</p>
        )}
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
        onClick={() => setOpen((value) => !value)}
      >
        <Caret open={open} />
        <span className="hydra-tree__title">{title}</span>
        <span className="hydra-tree__count">{count}</span>
      </button>
      {open ? (
        <div className="hydra-tree__body" role="group">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function RepoGroup({ group }: { group: BoardGroup }): JSX.Element {
  const [open, setOpen] = useState(true);
  // The base branch a repo's workers fork from is not carried on the session
  // DTO, so it is omitted here (would require a new protocol field). The group
  // still collapses and shows its repo label + worker count.

  return (
    <div className="hydra-repo">
      <button
        type="button"
        className="hydra-repo__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Caret open={open} />
        <span className="hydra-repo__label">{group.label}</span>
        <span className="hydra-tree__count">{group.tiles.length}</span>
      </button>
      {open ? (
        <div className="hydra-repo__body" role="group">
          {group.tiles.map((tile) => (
            <TreeRow key={tile.session} tile={tile} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <span className={`hydra-caret${open ? ' hydra-caret--open' : ''}`} aria-hidden="true">
      ▸
    </span>
  );
}
