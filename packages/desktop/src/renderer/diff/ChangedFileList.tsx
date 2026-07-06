// The changed-file column: one selectable row per file with an add/mod/del/
// rename badge. Pure presentation over `ChangedFileView[]` from diffModel.

import type { ChangedFileView } from './diffModel';

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

interface ChangedFileListProps {
  files: ChangedFileView[];
  selectedPath: string | null;
  onSelect: (file: ChangedFileView) => void;
}

export function ChangedFileList({
  files,
  selectedPath,
  onSelect,
}: ChangedFileListProps): JSX.Element {
  return (
    <div className="hydra-diff__files">
      <ul className="hydra-diff__file-list">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="hydra-diff__file"
              aria-selected={file.path === selectedPath}
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => onSelect(file)}
            >
              <span
                className={`hydra-diff__badge hydra-diff__badge--${file.kind}`}
                aria-label={file.badge.label}
              >
                {file.badge.symbol}
              </span>
              {/* rtl + bdi left-truncates long paths, keeping the filename visible */}
              <span className="hydra-diff__path">
                <bdi>{file.path}</bdi>
                {file.oldPath ? (
                  <span className="hydra-diff__rename"> (was {baseName(file.oldPath)})</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
