// SessionsProvider — the single owner of the live board + every session
// mutation, shared by the sidebar tree, the status bar, the row menus and the
// Overview tab. It is the tab-shell's port of the old MissionControl container:
// it holds the HydraControlClient, the live board hook, the dialog state and the
// action handlers that call the client verbs, and it renders the dialogs +
// error banner as global overlays. Consumers read it via `useSessions()`.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { CreateCopilotInput, CreateWorkerInput } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import { useMissionControlBoard, type MissionControlBoard } from '../missionControl/useMissionControlBoard';
import { CreateSessionModal, type CreateKind } from '../missionControl/CreateSessionModal';
import { ConfirmDeleteModal, PromptModal } from '../missionControl/dialogs';
import type { TileModel, WorkerTileModel } from '../missionControl/boardModel';
import {
  completionNotificationClearFiltersForTile,
  completionNotificationClearFiltersForWorkerSession,
} from './notificationClear';

/** Every session mutation the UI can trigger, from any surface. */
export interface SessionActions {
  create: (kind: CreateKind) => void;
  broadcast: () => void;
  restore: () => void;
  refresh: () => void;
  send: (tile: TileModel) => void;
  rename: (tile: TileModel) => void;
  delete: (tile: TileModel) => void;
  acknowledgeCompletion: (tile: TileModel) => void;
  acknowledgeWorkerCompletion: (session: string) => void;
  markNotificationRead: (id: string) => void;
  dismissNotification: (id: string) => void;
  start: (tile: TileModel) => void;
  stop: (tile: WorkerTileModel) => void;
}

export interface SessionsApi {
  readonly board: MissionControlBoard;
  readonly actions: SessionActions;
}

type Dialog =
  | { type: 'create'; kind: CreateKind }
  | { type: 'rename'; tile: TileModel }
  | { type: 'send'; tile: TileModel }
  | { type: 'delete'; tile: TileModel }
  | { type: 'restore' }
  | { type: 'broadcast' };

const SessionsContext = createContext<SessionsApi | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useHydraClient();
  const board = useMissionControlBoard(client);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
    setBusy(false);
  }, []);

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
        board.refresh();
      } catch (cause) {
        setBusy(false);
        setDialogError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [board],
  );

  // A mutation straight from a tile / row (start / stop): errors go to the
  // top-level banner since there is no dialog to host them.
  const runDirect = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBanner(null);
      try {
        await fn();
        board.refresh();
      } catch (cause) {
        setBanner(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [board],
  );

  const actions = useMemo<SessionActions>(
    () => ({
      create: (kind) => setDialog({ type: 'create', kind }),
      broadcast: () => setDialog({ type: 'broadcast' }),
      restore: () => setDialog({ type: 'restore' }),
      refresh: () => board.refresh(),
      send: (tile) => setDialog({ type: 'send', tile }),
      rename: (tile) => setDialog({ type: 'rename', tile }),
      delete: (tile) => setDialog({ type: 'delete', tile }),
      acknowledgeCompletion: (tile) => {
        if (tile.kind === 'worker' && tile.completed) {
          void runDirect(() => client.clearNotifications(completionNotificationClearFiltersForTile(tile)));
        }
      },
      acknowledgeWorkerCompletion: (session) =>
        runDirect(() => client.clearNotifications(completionNotificationClearFiltersForWorkerSession(session))),
      markNotificationRead: (id) => runDirect(() => client.markNotificationRead(id)),
      dismissNotification: (id) => runDirect(() => client.dismissNotification(id)),
      start: (tile) => runDirect(() => client.startSession(tile.session, tile.kind)),
      stop: (tile) => runDirect(() => client.stopWorker(tile.session)),
    }),
    [board, client, runDirect],
  );

  const value = useMemo<SessionsApi>(() => ({ board, actions }), [board, actions]);

  return (
    <SessionsContext.Provider value={value}>
      {banner ? (
        <div className="hydra-toast">
          <div className="hydra-banner hydra-banner--error" role="alert">
            <span>{banner}</span>
            <button type="button" className="hydra-banner__close" aria-label="Dismiss" onClick={() => setBanner(null)}>
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {children}

      {dialog?.type === 'create' ? (
        <CreateSessionModal
          initialKind={dialog.kind}
          copilots={(board.view?.groups ?? []).flatMap(group => group.tiles)
            .filter((tile): tile is Extract<TileModel, { kind: 'copilot' }> => tile.kind === 'copilot')
            .map(tile => ({ session: tile.session, name: tile.name, running: tile.lifecycle === 'running' }))}
          busy={busy}
          error={dialogError}
          onCreateWorker={(input: CreateWorkerInput) => runDialog(() => client.createWorker(input))}
          onCreateCopilot={(input: CreateCopilotInput) => runDialog(() => client.createCopilot(input))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'rename' ? (
        <PromptModal
          title={`Rename ${dialog.tile.name}`}
          label="New name"
          submitLabel="Rename"
          initialValue={dialog.tile.name}
          busy={busy}
          error={dialogError}
          onSubmit={(name) => runDialog(() => client.renameSession(dialog.tile.session, dialog.tile.kind, name))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'send' ? (
        <PromptModal
          title={`Send to ${dialog.tile.name}`}
          label="Message"
          submitLabel="Send"
          placeholder="fix the failing test"
          multiline
          busy={busy}
          error={dialogError}
          onSubmit={(message) => runDialog(() => client.sendMessage(dialog.tile.session, dialog.tile.kind, message))}
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.type === 'delete' ? (
        <ConfirmDeleteModal
          name={dialog.tile.name}
          canDeleteFiles={dialog.tile.kind === 'worker'}
          busy={busy}
          error={dialogError}
          onConfirm={(deleteFiles) =>
            runDialog(() => client.deleteSession(dialog.tile.session, dialog.tile.kind, { deleteFiles }))
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
