// A minimal modal shell: a centered panel over a dimming backdrop, closable by
// backdrop click, the close button, or Escape. Electron disables window.prompt, so
// every text-entry action in Mission Control routes through a real modal.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from '../ui/icons';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const focusableSelector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'summary',
      '[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusInitialControl = window.requestAnimationFrame(() => {
      const formControlSelector = [
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        'button:not([disabled])',
      ].join(',');
      const initial = dialog?.querySelector<HTMLElement>(
        '[data-hydra-autofocus="true"]:not([disabled])',
      ) ?? dialog?.querySelector<HTMLElement>(`.hydra-modal__body ${formControlSelector}`)
        ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      initial?.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(focusInitialControl);
      window.removeEventListener('keydown', onKey);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div className="hydra-modal__backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="hydra-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="hydra-modal__head">
          <h2 id={titleId} className="hydra-modal__title">{title}</h2>
          <button type="button" className="hydra-modal__close" aria-label="Close" onClick={onClose}>
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <div className="hydra-modal__body">{children}</div>
      </div>
    </div>
  );
}
