// Renderer mutation owner. Domain state stays in DesktopControlProvider; this
// provider owns dialogs and calls HydraControlClient lifecycle verbs.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  CreateCopilotInput,
  CreationOptionsResult,
  CreateWorkerInput,
} from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import { useDesktopControl, type DesktopControlState } from '../controlState/useDesktopControlState';
import { CreateSessionModal, type CreateKind } from '../missionControl/CreateSessionModal';
import { ConfirmDeleteModal, PromptModal } from '../missionControl/dialogs';
import { X } from '../ui/icons';

/** Every session mutation the UI can trigger, from any surface. */
export interface SessionActionTarget {
  readonly kind: 'worker' | 'copilot';
  readonly session: string;
  readonly name: string;
}

export interface WorkerActionTarget extends SessionActionTarget {
  readonly kind: 'worker';
}

export interface CreateSessionOptions {
  readonly copilotSession?: string;
  readonly repo?: string;
  readonly workerType?: 'code' | 'task';
}

export interface SessionActions {
  create: (kind: CreateKind, options?: CreateSessionOptions) => void;
  broadcast: () => void;
  restore: () => void;
  refresh: () => void;
  send: (target: SessionActionTarget) => void;
  rename: (target: SessionActionTarget) => void;
  delete: (target: SessionActionTarget) => void;
  markNotificationRead: (id: string) => void;
  dismissNotification: (id: string) => void;
  start: (target: SessionActionTarget) => void;
  stop: (target: WorkerActionTarget) => void;
}

export interface SessionsApi {
  readonly control: DesktopControlState;
  readonly actions: SessionActions;
}

type Dialog =
  | {
    type: 'create';
    kind: CreateKind;
    copilotSession?: string;
    repo?: string;
    workerType?: 'code' | 'task';
  }
  | { type: 'rename'; target: SessionActionTarget }
  | { type: 'send'; target: SessionActionTarget }
  | { type: 'delete'; target: SessionActionTarget }
  | { type: 'restore' }
  | { type: 'broadcast' };

const SessionsContext = createContext<SessionsApi | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useHydraClient();
  const control = useDesktopControl();

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [creationOptions, setCreationOptions] = useState<CreationOptionsResult | null>(null);
  const [creationOptionsError, setCreationOptionsError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
    setCreationOptions(null);
    setCreationOptionsError(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (dialog?.type !== 'create') return;
    let active = true;
    client.getCreationOptions().then((options) => {
      if (!active) return;
      setCreationOptions(options);
      setCreationOptionsError(null);
    }).catch((cause) => {
      if (!active) return;
      setCreationOptionsError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
    };
  }, [client, dialog?.type]);

  // A mutation from within a dialog: keep the dialog open on failure (inline
  // error), close + resync on success.
  const runDialog = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setDialogError(null);
      try {
        await fn();
        setDialog(null);
        setBusy(false);
        control.refresh();
      } catch (cause) {
        setBusy(false);
        setDialogError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [control],
  );

  // A mutation straight from a tile / row (start / stop): errors go to the
  // top-level banner since there is no dialog to host them.
  const runDirect = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBanner(null);
      try {
        await fn();
        control.refresh();
      } catch (cause) {
        setBanner(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [control],
  );

  const actions = useMemo<SessionActions>(
    () => ({
      create: (kind, options) => {
        setCreationOptions(null);
        setCreationOptionsError(null);
        setDialog({
          type: 'create',
          kind,
          copilotSession: options?.copilotSession,
          repo: options?.repo,
          workerType: options?.workerType,
        });
      },
      broadcast: () => setDialog({ type: 'broadcast' }),
      restore: () => setDialog({ type: 'restore' }),
      refresh: () => control.refresh(),
      send: (target) => setDialog({ type: 'send', target }),
      rename: (target) => setDialog({ type: 'rename', target }),
      delete: (target) => setDialog({ type: 'delete', target }),
      markNotificationRead: (id) => runDirect(() => client.markNotificationRead(id)),
      dismissNotification: (id) => runDirect(() => client.dismissNotification(id)),
      start: (tile) => runDirect(() => client.startSession(tile.session, tile.kind)),
      stop: (tile) => runDirect(() => client.stopWorker(tile.session)),
    }),
    [control, client, runDirect],
  );

  const value = useMemo<SessionsApi>(() => ({ control, actions }), [control, actions]);

  return (
    <SessionsContext.Provider value={value}>
      {banner ? (
        <div className="hydra-toast">
          <div className="hydra-banner hydra-banner--error" role="alert">
            <span>{banner}</span>
            <button type="button" className="hydra-banner__close" aria-label="Dismiss" onClick={() => setBanner(null)}>
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {children}

      {dialog?.type === 'create' ? (
        <CreateSessionModal
          initialKind={dialog.kind}
          initialCopilot={dialog.copilotSession}
          initialRepo={dialog.repo}
          initialWorkerType={dialog.workerType}
          creationOptions={creationOptions}
          optionsError={creationOptionsError}
          optionsLoading={creationOptions === null && creationOptionsError === null}
          copilots={(control.view?.copilots ?? []).map(copilot => ({
            session: copilot.session,
            name: copilot.name,
            running: copilot.lifecycle === 'running',
          }))}
          busy={busy}
          error={dialogError}
          onCreateWorker={(input: CreateWorkerInput) => runDialog(() => client.createWorker(input))}
          onCreateCopilot={(input: CreateCopilotInput) => runDialog(() => client.createCopilot(input))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'rename' ? (
        <PromptModal
          title={`Rename ${dialog.target.name}`}
          label="New name"
          submitLabel="Rename"
          initialValue={dialog.target.name}
          busy={busy}
          error={dialogError}
          onSubmit={(name) => runDialog(() => client.renameSession(
            dialog.target.session,
            dialog.target.kind,
            name,
          ))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'send' ? (
        <PromptModal
          title={`Send to ${dialog.target.name}`}
          label="Message"
          submitLabel="Send"
          placeholder="fix the failing test"
          multiline
          busy={busy}
          error={dialogError}
          onSubmit={(message) => runDialog(() => client.sendMessage(
            dialog.target.session,
            dialog.target.kind,
            message,
          ))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'delete' ? (
        <ConfirmDeleteModal
          name={dialog.target.name}
          canDeleteFiles={dialog.target.kind === 'worker'}
          busy={busy}
          error={dialogError}
          onConfirm={(deleteFiles) =>
            runDialog(() => client.deleteSession(
              dialog.target.session,
              dialog.target.kind,
              { deleteFiles },
            ))
          }
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'restore' ? (
        <PromptModal
          title="Restore archived session"
          label="Session name"
          submitLabel="Restore"
          placeholder="repo-abc123_feat-foo"
          busy={busy}
          error={dialogError}
          onSubmit={(session) => runDialog(() => client.restoreSession(session))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'broadcast' ? (
        <PromptModal
          title="Broadcast to all workers"
          label="Message"
          submitLabel="Broadcast"
          placeholder="wrap up and push your branch"
          multiline
          busy={busy}
          error={dialogError}
          onSubmit={(message) => runDialog(() => client.broadcastToWorkers(message))}
          onClose={closeDialog}
        />
      ) : null}
    </SessionsContext.Provider>
  );
}

/** Access the shared board + session actions. Throws outside the provider. */
export function useSessions(): SessionsApi {
  const api = useContext(SessionsContext);
  if (!api) {
    throw new Error('useSessions must be used within <SessionsProvider>');
  }
  return api;
}
