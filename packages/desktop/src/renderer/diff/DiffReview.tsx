// The Diff Review screen (M4). Orchestrates the seam hooks + the pure diffModel
// mapping into: a header, the minimal ship handoff, a changed-file column, and
// the per-file diff pane. Read-only review + ship handoff only — no editor
// (FINAL.md risk #3).

import { useEffect, useMemo, useState } from 'react';

import { toChangedFileList, type ChangedFileView } from './diffModel';
import { ChangedFileList } from './ChangedFileList';
import { DiffStyles } from './DiffStyles';
import { FileDiffView, type DiffViewMode } from './FileDiffView';
import { ShipHandoff } from './ShipHandoff';
import { useDiff, useFileDiff } from './useDiff';

interface DiffReviewProps {
  session: string;
}

export function DiffReview({ session }: DiffReviewProps): JSX.Element {
  const { summary, loading, error, reload } = useDiff(session);
  const [mode, setMode] = useState<DiffViewMode>('split');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const files = useMemo<ChangedFileView[]>(
    () => (summary ? toChangedFileList(summary) : []),
    [summary],
  );

  // Select the first changed file once a summary arrives (or when the selected
  // file vanishes after a reload).
  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }
    setSelectedPath((current) =>
      current && files.some((file) => file.path === current) ? current : files[0].path,
    );
  }, [files]);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  const fileDiff = useFileDiff(session, selectedFile);

  return (
    <section className="hydra-diff">
      <DiffStyles />
      <header className="hydra-diff__header">
        <h1 className="hydra-diff__title">Diff — {session}</h1>
        {summary ? (
          <span className="hydra-diff__meta">
            <code>{summary.branch || 'detached HEAD'}</code> vs <code>{summary.baseRef}</code> ·{' '}
            {summary.count} file{summary.count === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="hydra-diff__spacer" />
        <div className="hydra-diff__toolbar">
          <button
            type="button"
            className="hydra-diff__button"
            aria-pressed={mode === 'split'}
            onClick={() => setMode('split')}
          >
            Split
          </button>
          <button
            type="button"
            className="hydra-diff__button"
            aria-pressed={mode === 'inline'}
            onClick={() => setMode('inline')}
          >
            Inline
          </button>
          <button
            type="button"
            className="hydra-diff__button"
            onClick={reload}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error ? (
        <p className="hydra-status hydra-status--error">Failed to load diff: {error}</p>
      ) : null}

      {summary && !error ? (
        <ShipHandoff branch={summary.branch} workdir={summary.workdir} />
      ) : null}

      {loading && !summary ? <p className="hydra-status">Loading diff…</p> : null}

      {summary && !error && files.length === 0 ? (
        <p className="hydra-empty">No changes against {summary.baseRef}.</p>
      ) : null}

      {files.length > 0 ? (
        <div className="hydra-diff__body">
          <ChangedFileList
            files={files}
            selectedPath={selectedPath}
            onSelect={(file) => setSelectedPath(file.path)}
          />
          {selectedFile ? (
            <FileDiffView file={selectedFile} state={fileDiff} mode={mode} />
          ) : (
            <div className="hydra-diff__pane">
              <p className="hydra-diff__hint">Select a file to see its diff.</p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
