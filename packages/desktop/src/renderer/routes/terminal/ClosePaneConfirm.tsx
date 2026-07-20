import { Modal } from '../../missionControl/Modal';
import { createPortal } from 'react-dom';

export interface ClosePaneConfirmProps {
  label: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ClosePaneConfirm({
  label,
  busy,
  error,
  onConfirm,
  onClose,
}: ClosePaneConfirmProps): JSX.Element {
  return createPortal(
    <Modal title={`Close ${label}?`} onClose={onClose} closeDisabled={busy}>
      <div className="hydra-form">
        <p className="hydra-shell-close__warning">
          Running processes in this pane will stop.
        </p>
        {error ? <p className="hydra-form__error">{error}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="hydra-btn hydra-btn--danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Closing…' : 'Close pane'}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
