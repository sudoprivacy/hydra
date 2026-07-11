// A minimal modal shell: a centered panel over a dimming backdrop, closable by
// backdrop click, the close button, or Escape. Electron disables window.prompt, so
// every text-entry action in Mission Control routes through a real modal.

import { useEffect, type ReactNode } from 'react';
import { X } from '../ui/icons';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="hydra-modal__backdrop" onMouseDown={onClose}>
      <div
        className="hydra-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="hydra-modal__head">
          <h2 className="hydra-modal__title">{title}</h2>
          <button type="button" className="hydra-modal__close" aria-label="Close" onClick={onClose}>
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <div className="hydra-modal__body">{children}</div>
      </div>
    </div>
  );
}
