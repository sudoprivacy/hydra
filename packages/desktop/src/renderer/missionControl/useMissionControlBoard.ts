// useMissionControlBoard — the live wiring between the HydraControlClient and
// the pure board model. It:
//   1. loads the authoritative snapshot with `listSessions()`,
//   2. subscribes to `subscribeEvents()` and `subscribeNotifications()`,
//   3. folds every delta through the pure reducer in boardModel.ts, and
//   4. refetches the snapshot (debounced) when a membership event lands, since
//      those events do not carry a full tile DTO.
//
// The board is thus LIVE, not polled: a `worker.runtime.changed` frame flips a
// tile's badge in place; a `notify.created` frame bumps its unread count — no
// round-trip. All engine/transport contact is confined here; the reducer stays
// pure and headless-testable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HydraControlClient, HydraEvent, NotificationSnapshot } from '@hydra/protocol';

import {
  applyEvents,
  applyNotificationSnapshot,
  applySnapshot,
  createBoardModel,
  isMembershipEvent,
  selectBoard,
  type BoardModel,
  type BoardView,
} from './boardModel';

/** Coalesce an event burst (e.g. a backlog drain) into a single render. */
const EVENT_FLUSH_MS = 16;
/** Collapse a storm of membership events into one `listSessions()` refetch. */
const RESYNC_DEBOUNCE_MS = 120;

export interface MissionControlBoard {
  /** The grouped, sorted view — `null` until the first snapshot loads. */
  readonly view: BoardView | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** Whether the live event/notification streams are currently connected. */
  readonly connected: boolean;
  /** Force an immediate `listSessions()` resync. */
  readonly refresh: () => void;
  /** Highest event seq applied — a heartbeat the UI can surface. */
  readonly lastSeq: number;
}

/**
 * Drive an async iterable to `onValue` with cooperative cancellation. Returning
 * the iterator on cancel triggers the transport generator's `finally`, which
 * closes the underlying socket even while we are awaiting the next frame.
 */
function consume<T>(
  iterable: AsyncIterable<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
): () => void {
  const iterator = iterable[Symbol.asyncIterator]();
  let cancelled = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || cancelled) {
          return;
        }
        onValue(value);
      }
    } catch (error) {
      if (!cancelled) {
        onError(error);
      }
    }
  })();
  return () => {
    cancelled = true;
    void iterator.return?.().catch(() => {});
  };
}

export function useMissionControlBoard(client: HydraControlClient): MissionControlBoard {
  const [model, setModel] = useState<BoardModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Mutable scratch shared across the effect's async callbacks.
  const eventBuffer = useRef<HydraEvent[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resyncInFlight = useRef(false);
  const disposed = useRef(false);

  // A stable ref to the running refetch so `refresh()` and the debounce share it.
  const runResync = useRef<() => void>(() => {});

  useEffect(() => {
    disposed.current = false;

    const flushEvents = () => {
      flushTimer.current = null;
      const batch = eventBuffer.current;
      if (batch.length === 0) {
        return;
      }
      eventBuffer.current = [];
      setModel((prev) => (prev ? applyEvents(prev, batch) : prev));
      if (batch.some((event) => isMembershipEvent(event.type))) {
        scheduleResync();
      }
    };

    const scheduleFlush = () => {
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(flushEvents, EVENT_FLUSH_MS);
      }
    };

    const resyncNow = () => {
      if (disposed.current || resyncInFlight.current) {
        return;
      }
      resyncInFlight.current = true;
      client
        .listSessions()
        .then((snapshot) => {
          if (disposed.current) {
            return;
          }
          setModel((prev) => (prev ? applySnapshot(prev, snapshot) : createBoardModel(snapshot)));
        })
        .catch((cause: unknown) => {
          if (!disposed.current) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        })
        .finally(() => {
          resyncInFlight.current = false;
        });
    };
    runResync.current = resyncNow;

    function scheduleResync(): void {
      if (resyncTimer.current !== null) {
        return;
      }
      resyncTimer.current = setTimeout(() => {
        resyncTimer.current = null;
        resyncNow();
      }, RESYNC_DEBOUNCE_MS);
    }

    // 1. Authoritative first paint.
    client
      .listSessions()
      .then((snapshot) => {
        if (!disposed.current) {
          setModel(createBoardModel(snapshot));
        }
      })
      .catch((cause: unknown) => {
        if (!disposed.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    // 2. Live event stream → coalesced reducer deltas.
    const stopEvents = consume<HydraEvent>(
      client.subscribeEvents(),
      (event) => {
        eventBuffer.current.push(event);
        scheduleFlush();
      },
      (cause) => {
        setConnected(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );

    // 3. Live notification stream → per-session unread counts.
    const stopNotifications = consume<NotificationSnapshot>(
      client.subscribeNotifications(),
      (snapshot) => {
        setConnected(true);
        setModel((prev) => (prev ? applyNotificationSnapshot(prev, snapshot) : prev));
      },
      (cause) => {
        setConnected(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );

    return () => {
      disposed.current = true;
      stopEvents();
      stopNotifications();
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (resyncTimer.current !== null) {
        clearTimeout(resyncTimer.current);
        resyncTimer.current = null;
      }
    };
  }, [client]);

  const refresh = useCallback(() => {
    runResync.current();
  }, []);

  const view = useMemo(() => (model ? selectBoard(model) : null), [model]);

  return {
    view,
    loading: model === null && error === null,
    error,
    connected,
    refresh,
    lastSeq: model?.lastSeq ?? 0,
  };
}
