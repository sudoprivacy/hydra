// The right-hand diff pane: renders the computed line diff for the selected
// file, either inline (single column, +/- signs) or side-by-side (two columns).
// All the diffing already happened in diffModel / useFileDiff — this is layout.

import { useState } from 'react';

import {
  collapseUnchangedRows,
  toSideBySide,
  type ChangedFileView,
  type DiffRow,
  type LineDiff,
} from './diffModel';
import type { FileDiffState } from './useDiff';

export type DiffViewMode = 'inline' | 'split';

const SIGN: Record<DiffRow['type'], string> = { context: ' ', add: '+', del: '-' };

function UnchangedGap({ count, onExpand }: { count: number; onExpand: () => void }): JSX.Element {
  return (
    <tr className="hydra-diff__gap">
      <td colSpan={4}>
        <button type="button" className="hydra-diff__gap-button" onClick={onExpand}>
          {count} unchanged line{count === 1 ? '' : 's'} — show
        </button>
      </td>
    </tr>
  );
}

function InlineDiff({ diff }: { diff: LineDiff }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const items = expanded
    ? diff.rows.map((row) => ({ kind: 'row' as const, row }))
    : collapseUnchangedRows(diff.rows, (row) => row.type === 'context');

  return (
    <table className="hydra-diff__code hydra-diff__code--inline" aria-label="Inline file diff">
      <tbody>
        {items.map((item, index) => item.kind === 'gap' ? (
          <UnchangedGap key={`gap-${index}`} count={item.count} onExpand={() => setExpanded(true)} />
        ) : (
          <tr key={`row-${index}`} className={`hydra-diff__row--${item.row.type}`}>
            <td className="hydra-diff__ln">{item.row.baseLine ?? ''}</td>
            <td className="hydra-diff__ln">{item.row.currentLine ?? ''}</td>
            <td className="hydra-diff__sign">{SIGN[item.row.type]}</td>
            <td className="hydra-diff__cell">{item.row.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiff({ diff }: { diff: LineDiff }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const rows = toSideBySide(diff.rows);
  const items = expanded
    ? rows.map((row) => ({ kind: 'row' as const, row }))
    : collapseUnchangedRows(
        rows,
        (row) => row.left.type === 'context' && row.right.type === 'context',
      );

  return (
    <table className="hydra-diff__code hydra-diff__code--split" aria-label="Side-by-side file diff">
      <tbody>
        {items.map((item, index) => item.kind === 'gap' ? (
          <UnchangedGap key={`gap-${index}`} count={item.count} onExpand={() => setExpanded(true)} />
        ) : (
          <tr key={index}>
            <td className="hydra-diff__ln">{item.row.left.lineNumber ?? ''}</td>
            <td
              className={`hydra-diff__cell hydra-diff__cell--${item.row.left.type}`}
              aria-label={item.row.left.type === 'empty' ? 'No base content' : undefined}
            >
              {item.row.left.text}
            </td>
            <td className="hydra-diff__ln hydra-diff__ln--right">{item.row.right.lineNumber ?? ''}</td>
            <td
              className={`hydra-diff__cell hydra-diff__cell--${item.row.right.type}`}
              aria-label={item.row.right.type === 'empty' ? 'No current content' : undefined}
            >
              {item.row.right.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface FileDiffViewProps {
  file: ChangedFileView;
  state: FileDiffState;
  mode: DiffViewMode;
}

export function FileDiffView({ file, state, mode }: FileDiffViewProps): JSX.Element {
  const { lineDiff, loading, error } = state;

  const stats = lineDiff
    ? { added: lineDiff.added, removed: lineDiff.removed }
    : { added: 0, removed: 0 };

  let body: JSX.Element;
  if (loading) {
    body = <p className="hydra-diff__hint">Loading {file.path}…</p>;
  } else if (error) {
    body = <p className="hydra-diff__hint">Could not load {file.path}: {error}</p>;
  } else if (!lineDiff || lineDiff.truncated) {
    body = <p className="hydra-diff__hint">{file.path} is too large to diff inline.</p>;
  } else if (lineDiff.added === 0 && lineDiff.removed === 0) {
    body = (
      <p className="hydra-diff__hint">
        {file.kind === 'added'
          ? 'New empty file.'
          : file.kind === 'deleted'
            ? 'Deleted empty file.'
            : `No line changes${file.kind === 'renamed' ? ' — renamed only.' : ' — metadata only.'}`}
      </p>
    );
  } else if (mode === 'split') {
    body = <SplitDiff key={file.path} diff={lineDiff} />;
  } else {
    body = <InlineDiff key={file.path} diff={lineDiff} />;
  }

  const sideNotice = file.kind === 'added'
    ? 'New file — the base side is empty.'
    : file.kind === 'deleted'
      ? 'Deleted file — the current side is empty.'
      : null;

  return (
    <div className="hydra-diff__pane">
      <div className="hydra-diff__filehead">
        <span className={`hydra-diff__badge hydra-diff__badge--${file.kind}`} aria-label={file.badge.label}>
          {file.badge.symbol}
        </span>
        <span>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        <span className="hydra-diff__spacer" />
        {lineDiff && !lineDiff.truncated ? (
          <span>
            <span className="hydra-diff__stat-add">+{stats.added}</span>{' '}
            <span className="hydra-diff__stat-del">−{stats.removed}</span>
          </span>
        ) : null}
      </div>
      {sideNotice && mode === 'split' ? (
        <div className="hydra-diff__side-note">{sideNotice}</div>
      ) : null}
      {body}
    </div>
  );
}
