import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  TerminalPaneCreateInput,
  TerminalPaneListResult,
  TerminalPaneSnapshot,
} from '@hydra/protocol';

import { useHydraClient } from '../../HydraClientProvider';
import { ChevronDown, Plus } from '../../ui/icons';
import { ClosePaneConfirm } from './ClosePaneConfirm';
import { NewShellPopover } from './NewShellPopover';

export interface NewShellControlProps {
  session: string;
  enabled: boolean;
  onTerminalFocus: () => void;
}

type CreateSettings = Pick<
  TerminalPaneCreateInput,
  'direction' | 'startDirectory' | 'command'
>;

export function NewShellControl({
  session,
  enabled,
  onTerminalFocus,
}: NewShellControlProps): JSX.Element {
  const client = useHydraClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const currentSessionRef = useRef(session);
  currentSessionRef.current = session;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<TerminalPaneListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closingPane, setClosingPane] = useState<TerminalPaneSnapshot | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!enabled) return;
    if (!quiet) setLoading(true);
    try {
      const result = await client.listTerminalPanes(session);
      if (currentSessionRef.current === session) setSnapshot(result);
      if (!quiet) setError(null);
    } catch (cause) {
      if (!quiet) setError(errorMessage(cause));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [client, enabled, session]);

  useEffect(() => {
    requestIdRef.current = null;
    setSnapshot(null);
    setError(null);
    setClosingPane(null);
    setCloseError(null);
  }, [session]);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setSnapshot(null);
      return;
    }
    void load();
  }, [enabled, load, session]);

  useEffect(() => {
    if (!open || !enabled || busy) return undefined;
    void load();
    const timer = window.setInterval(() => { void load(true); }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, enabled, load, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closingPane) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closingPane, open]);

  const create = async (settings: CreateSettings) => {
    if (!enabled || busy) return;
    const requestId = requestIdRef.current ?? crypto.randomUUID();
    requestIdRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const result = await client.createTerminalPane({ session, requestId, ...settings });
      setSnapshot(result);
      requestIdRef.current = null;
      onTerminalFocus();
    } catch (cause) {
      setError(errorMessage(cause));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const focus = async (paneId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await client.focusTerminalPane(session, paneId));
      onTerminalFocus();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!closingPane || busy) return;
    setBusy(true);
    setCloseError(null);
    try {
      const result = await client.closeTerminalPane(session, closingPane.paneId);
      setSnapshot(result);
      setClosingPane(null);
      onTerminalFocus();
    } catch (cause) {
      setCloseError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const paneCount = snapshot?.panes.length ?? 0;
  const maxPanes = snapshot?.maxPanes ?? 4;
  const capReached = paneCount >= maxPanes;
  const disabled = !enabled || busy || capReached;

  return (
    <div ref={rootRef} className="hydra-new-shell">
      <div className="hydra-new-shell__buttons">
        <button
          type="button"
          className="hydra-new-shell__primary"
          title={capReached ? `Maximum ${maxPanes} panes` : 'Open a shell below the Agent'}
          disabled={disabled}
          onClick={() => void create({
            direction: 'down',
            startDirectory: 'session-workdir',
          })}
        >
          <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>New Shell</span>
        </button>
        <button
          type="button"
          className="hydra-new-shell__disclosure"
          aria-label="Manage terminal panes"
          aria-expanded={open}
          disabled={!enabled || busy}
          onClick={() => setOpen(value => !value)}
        >
          <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <NewShellPopover
          panes={snapshot?.panes ?? []}
          maxPanes={maxPanes}
          loading={loading}
          busy={busy}
          error={error}
          onCreate={(settings) => void create(settings)}
          onFocus={(paneId) => void focus(paneId)}
          onRequestClose={(pane) => {
            setCloseError(null);
            setClosingPane(pane);
          }}
        />
      ) : null}
      {closingPane ? (
        <ClosePaneConfirm
          label={closingPane.label}
          busy={busy}
          error={closeError}
          onConfirm={() => void close()}
          onClose={() => {
            if (!busy) {
              setClosingPane(null);
              setCloseError(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
