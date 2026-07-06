// The small text-entry + confirm dialogs the board drives (rename, send /
// broadcast a message, restore an archived session, delete with an optional
// deleteFiles flag). Each is a thin controlled form over the shared Modal shell;
// submission is delegated to the caller, which owns the client verb.

import { useState, type FormEvent } from 'react';

import { Modal } from './Modal';

interface PromptModalProps {
  title: string;
  label: string;
  submitLabel: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  /** Empty input is rejected unless this is true. */
  allowEmpty?: boolean;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** A single text/textarea prompt — the Electron-safe replacement for window.prompt. */
export function PromptModal({
  title,
  label,
  submitLabel,
  placeholder,
  initialValue = '',
  multiline = false,
  allowEmpty = false,
  busy = false,
  error,
  onSubmit,
  onClose,
}: PromptModalProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const canSubmit = !busy && (allowEmpty || trimmed.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) {
      onSubmit(trimmed);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="hydra-form" onSubmit={submit}>
        <label className="hydra-field">
          <span className="hydra-field__label">{label}</span>
          {multiline ? (
            <textarea
              className="hydra-field__input"
              rows={4}
              autoFocus
              placeholder={placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <input
              className="hydra-field__input"
              type="text"
              autoFocus
              placeholder={placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </label>
        {error ? <p className="hydra-form__error">{error}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hydra-btn hydra-btn--primary" disabled={!canSubmit}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ConfirmDeleteModalProps {
  name: string;
  /** Code/task workers can also drop their worktree/folder; copilots cannot. */
  canDeleteFiles: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (deleteFiles: boolean) => void;
  onClose: () => void;
}

/** Delete confirmation with the destructive deleteFiles opt-in. */
export function ConfirmDeleteModal({
  name,
  canDeleteFiles,
  busy = false,
  error,
  onConfirm,
  onClose,
}: ConfirmDeleteModalProps): JSX.Element {
  const [deleteFiles, setDeleteFiles] = useState(false);

  return (
    <Modal title="Delete session" onClose={onClose}>
      <div className="hydra-form">
        <p>
          Delete <strong>{name}</strong>? This archives the session and stops its tmux pane.
        </p>
        {canDeleteFiles ? (
          <label className="hydra-checkbox">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(event) => setDeleteFiles(event.target.checked)}
            />
            <span>
              Also delete files (worktree / managed folder). <em>Irreversible.</em>
            </span>
          </label>
        ) : null}
        {error ? <p className="hydra-form__error">{error}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="hydra-btn hydra-btn--danger"
            disabled={busy}
            onClick={() => onConfirm(canDeleteFiles && deleteFiles)}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
