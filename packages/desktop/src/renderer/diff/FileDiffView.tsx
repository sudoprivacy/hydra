// The right-hand diff pane: renders the computed line diff for the selected
// file, either inline (single column, +/- signs) or side-by-side (two columns).
// All the diffing already happened in diffModel / useFileDiff — this is layout.

import { toSideBySide, type ChangedFileView, type DiffRow, type LineDiff } from './diffModel';
import type { FileDiffState } from './useDiff';

export type DiffViewMode = 'inline' | 'split';

const SIGN: Record<DiffRow['type'], string> = { context: ' ', add: '+', del: '-' };

function InlineDiff({ diff }: { diff: LineDiff }): JSX.Element {
  return (
    <table className="hydra-diff__code">
      <tbody>
        {diff.rows.map((row, index) => (
          <tr key={index} className={`hydra-diff__row--${row.type}`}>
            <td className="hydra-diff__ln">{row.baseLine ?? ''}</td>
            <td className="hydra-diff__ln">{row.currentLine ?? ''}</td>
            <td className="hydra-diff__sign">{SIGN[row.type]}</td>
            <td>{row.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiff({ diff }: { diff: LineDiff }): JSX.Element {
  const rows = toSideBySide(diff.rows);
  return (
    <table className="hydra-diff__code">
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            <td className="hydra-diff__ln">{row.left.lineNumber ?? ''}</td>
            <td className={row.left.type === 'empty' ? 'hydra-diff__cell--empty' : `hydra-diff__row--${row.left.type}`}>
              {row.left.text}
            </td>
            <td className="hydra-diff__ln">{row.right.lineNumber ?? ''}</td>
            <td className={row.right.type === 'empty' ? 'hydra-diff__cell--empty' : `hydra-diff__row--${row.right.type}`}>
              {row.right.text}
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
  } else if (lineDiff.rows.length === 0) {
    body = (
      <p className="hydra-diff__hint">
        No line changes{file.kind === 'renamed' ? ' — renamed only.' : '.'}
      </p>
    );
  } else if (mode === 'split') {
    body = <SplitDiff diff={lineDiff} />;
  } else {
    body = <InlineDiff diff={lineDiff} />;
  }

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
      {body}
    </div>
  );
}
