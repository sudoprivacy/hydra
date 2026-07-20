import { useState, type FormEvent } from 'react';

import type {
  TerminalPaneSnapshot,
  TerminalPaneCreateInput,
} from '@hydra/protocol';

import { LockKeyhole, Terminal, Trash2 } from '../../ui/icons';

type StartDirectory = TerminalPaneCreateInput['startDirectory'];
type PaneDirection = TerminalPaneCreateInput['direction'];

export interface NewShellPopoverProps {
  panes: TerminalPaneSnapshot[];
  maxPanes: number;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (settings: {
    direction: PaneDirection;
    startDirectory: StartDirectory;
    command?: string;
  }) => void;
  onFocus: (paneId: string) => void;
  onRequestClose: (pane: TerminalPaneSnapshot) => void;
}

export function NewShellPopover({
  panes,
  maxPanes,
  loading,
  busy,
  error,
  onCreate,
  onFocus,
  onRequestClose,
}: NewShellPopoverProps): JSX.Element {
  const [direction, setDirection] = useState<PaneDirection>('down');
  const [startDirectory, setStartDirectory] = useState<StartDirectory>('session-workdir');
  const [command, setCommand] = useState('');
  const capReached = panes.length >= maxPanes;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || capReached) return;
    onCreate({
      direction,
      startDirectory,
      command: command.trim() ? command : undefined,
    });
  };

  return (
    <div className="hydra-shell-popover" role="dialog" aria-label="Manage terminal panes">
      <section className="hydra-shell-popover__section">
        <div className="hydra-shell-popover__heading">
          <strong>Open panes</strong>
          <span>{panes.length}/{maxPanes}</span>
        </div>
        {loading && panes.length === 0 ? (
          <p className="hydra-shell-popover__empty">Loading panes…</p>
        ) : panes.length === 0 ? (
          <p className="hydra-shell-popover__empty">No panes available.</p>
        ) : (
          <div className="hydra-shell-popover__panes">
            {panes.map(pane => (
              <div
                key={pane.paneId}
                className={`hydra-shell-pane${pane.active ? ' hydra-shell-pane--active' : ''}`}
              >
                <button
                  type="button"
                  className="hydra-shell-pane__focus"
                  disabled={busy}
                  title={`Focus ${pane.label}`}
                  onClick={() => onFocus(pane.paneId)}
                >
                  {pane.role === 'agent'
                    ? <LockKeyhole size={14} strokeWidth={1.7} aria-hidden="true" />
                    : <Terminal size={14} strokeWidth={1.7} aria-hidden="true" />}
                  <span className="hydra-shell-pane__copy">
                    <strong>{pane.label}</strong>
                    <small>{paneDetail(pane)}</small>
                  </span>
                  {pane.active ? <span className="hydra-shell-pane__active">active</span> : null}
                </button>
                {pane.canClose ? (
                  <button
                    type="button"
                    className="hydra-shell-pane__close"
                    aria-label={`Close ${pane.label}`}
                    title={`Close ${pane.label}`}
                    disabled={busy}
                    onClick={() => onRequestClose(pane)}
                  >
                    <Trash2 size={13} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <form className="hydra-shell-popover__section hydra-shell-popover__create" onSubmit={submit}>
        <div className="hydra-shell-popover__heading">
          <strong>New shell</strong>
          {capReached ? <span>Limit reached</span> : null}
        </div>
        <div className="hydra-shell-popover__grid">
          <label className="hydra-field">
            <span className="hydra-field__label">Split</span>
            <select
              className="hydra-field__input"
              value={direction}
              disabled={busy}
              onChange={(event) => setDirection(event.target.value as PaneDirection)}
            >
              <option value="down">Down · 35%</option>
              <option value="right">Right · 40%</option>
            </select>
          </label>
          <label className="hydra-field">
            <span className="hydra-field__label">Start in</span>
            <select
              className="hydra-field__input"
              value={startDirectory}
              disabled={busy}
              onChange={(event) => setStartDirectory(event.target.value as StartDirectory)}
            >
              <option value="session-workdir">Session workdir</option>
              <option value="agent-current-directory">Agent current directory</option>
            </select>
          </label>
        </div>
        <label className="hydra-field">
          <span className="hydra-field__label">Run command <em>optional</em></span>
          <input
            className="hydra-field__input"
            type="text"
            value={command}
            maxLength={4096}
            disabled={busy}
            placeholder="npm run dev"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        {error ? <p className="hydra-form__error">{error}</p> : null}
        <button
          type="submit"
          className="hydra-btn hydra-btn--primary hydra-shell-popover__submit"
          disabled={busy || capReached}
        >
          {busy ? 'Working…' : 'Create pane'}
        </button>
      </form>
    </div>
  );
}

function paneDetail(pane: TerminalPaneSnapshot): string {
  return [pane.currentCommand, pane.currentPath].filter(Boolean).join(' · ') || pane.title;
}
