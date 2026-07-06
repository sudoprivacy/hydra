// /mission-control — the fleet cockpit (M2).
//
// Container: it owns the HydraControlClient, the live board hook, the dialog
// state, and the action handlers that call the client verbs. Everything below
// it (the board, tiles, dialogs) is presentational. The board is driven by
// listSessions() + subscribeEvents() + subscribeNotifications() through the pure
// reducer in missionControl/boardModel.ts — live, never polled.

import { useCallback, useMemo, useState } from 'react';

import type { CreateCopilotInput, CreateWorkerInput } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import { MissionControlBoard } from '../missionControl/MissionControlBoard';
import { useMissionControlBoard } from '../missionControl/useMissionControlBoard';
import { CreateSessionModal, type CreateKind } from '../missionControl/CreateSessionModal';
import { ConfirmDeleteModal, PromptModal } from '../missionControl/dialogs';
import type { TileActions } from '../missionControl/SessionTile';
import type { TileModel, WorkerTileModel } from '../missionControl/boardModel';

type Dialog =
  | { type: 'create'; kind: CreateKind }
  | { type: 'rename'; tile: TileModel }
  | { type: 'send'; tile: TileModel }
  | { type: 'delete'; tile: TileModel }
  | { type: 'restore' }
  | { type: 'broadcast' };

export function MissionControl(): JSX.Element {
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

  // A mutation invoked from within a dialog: keep the dialog open on failure
  // (inline error), close + resync on success.
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

  // A mutation invoked straight from a tile (start / stop): errors go to the
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

  const tileActions = useMemo<TileActions>(
    () => ({
      onSend: (tile) => setDialog({ type: 'send', tile }),
      onRename: (tile) => setDialog({ type: 'rename', tile }),
      onDelete: (tile) => setDialog({ type: 'delete', tile }),
      onStart: (tile: TileModel) => runDirect(() => client.startSession(tile.session, tile.kind)),
      onStop: (tile: WorkerTileModel) => runDirect(() => client.stopWorker(tile.session)),
    }),
    [client, runDirect],
  );

  if (board.error && !board.view) {
    return <p className="hydra-status hydra-status--error">Failed to load sessions: {board.error}</p>;
  }
  if (!board.view) {
    return <p className="hydra-status">Loading sessions…</p>;
  }

  return (
    <>
      {banner ? (
        <div className="hydra-banner hydra-banner--error" role="alert">
          <span>{banner}</span>
          <button type="button" className="hydra-banner__close" aria-label="Dismiss" onClick={() => setBanner(null)}>
            ✕
          </button>
        </div>
      ) : null}

      <MissionControlBoard
        view={board.view}
        connected={board.connected}
        lastSeq={board.lastSeq}
        onRefresh={board.refresh}
        onCreate={(kind) => setDialog({ type: 'create', kind })}
        onBroadcast={() => setDialog({ type: 'broadcast' })}
        onRestore={() => setDialog({ type: 'restore' })}
        tileActions={tileActions}
      />

      {dialog?.type === 'create' ? (
        <CreateSessionModal
          initialKind={dialog.kind}
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
    </>
  );
}
