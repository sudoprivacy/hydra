import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import type {
  HydraControlClient,
  HydraEvent,
  NotificationOccurrenceSnapshotV2,
} from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import type { DesktopControlModel } from './model';
import {
  applyConnectionState,
  applyControlEvents,
  applyGitStatus,
  applyNotificationOccurrenceSnapshot,
  applyRuntimeSnapshot,
  applySessionsSnapshot,
  createDesktopControlModel,
} from './reducer';
import { selectDesktopControlView, type DesktopControlView } from './selectors';

const EVENT_FLUSH_MS = 16;
const REFRESH_DEBOUNCE_MS = 120;
const RUNTIME_REFRESH_COOLDOWN_MS = 1_000;
const GIT_STATUS_POLL_MS = 15_000;

export interface DesktopControlState {
  readonly model: DesktopControlModel | null;
  readonly view: DesktopControlView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly connected: boolean;
  readonly refresh: () => void;
}

const DesktopControlContext = createContext<DesktopControlState | null>(null);

export function DesktopControlProvider({ children }: { children: ReactNode }): ReactElement {
  const client = useHydraClient();
  const state = useDesktopControlState(client);
  return createElement(DesktopControlContext.Provider, { value: state }, children);
}

export function useDesktopControl(): DesktopControlState {
  const state = useContext(DesktopControlContext);
  if (!state) throw new Error('useDesktopControl must be used within <DesktopControlProvider>');
  return state;
}

export function useDesktopControlState(client: HydraControlClient): DesktopControlState {
  const [model, setModel] = useState<DesktopControlModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelRef = useRef<DesktopControlModel | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let streamsStarted = false;
    let stopEvents: () => void = () => {};
    let stopAttention: () => void = () => {};
    let eventBuffer: HydraEvent[] = [];
    let eventFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let runtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let baseRefreshInFlight = false;
    let baseRefreshPending = false;
    let runtimeRefreshInFlight = false;
    let lastRuntimeRefreshAt = 0;

    const commit = (next: DesktopControlModel) => {
      if (disposed) return;
      modelRef.current = next;
      setModel(next);
    };

    const update = (mutator: (current: DesktopControlModel) => DesktopControlModel) => {
      const current = modelRef.current;
      if (!current || disposed) return;
      commit(mutator(current));
    };

    const reportError = (cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    };

    const pollGitStatus = () => {
      if (disposed || !modelRef.current) return;
      void client.listGitStatus()
        .then(statuses => update(current => applyGitStatus(current, statuses)))
        .catch(() => {
          // Git status is best-effort context; keep the last successful values.
        });
    };

    const refreshRuntime = async () => {
      if (disposed || runtimeRefreshInFlight || !modelRef.current) return;
      runtimeRefreshInFlight = true;
      try {
        const runtime = await client.listWorkerRuntimeV2();
        update(current => applyRuntimeSnapshot(current, runtime));
        lastRuntimeRefreshAt = Date.now();
      } catch (cause) {
        reportError(cause);
      } finally {
        runtimeRefreshInFlight = false;
      }
    };

    const scheduleRuntimeRefresh = (reasons: readonly string[]) => {
      if (runtimeRefreshTimer !== null || disposed) return;
      if (reasons.length > 0) {
        console.warn('[hydra] ignored malformed/stale runtime event; refreshing v2 snapshot', reasons);
      }
      const cooldownRemaining = Math.max(
        0,
        RUNTIME_REFRESH_COOLDOWN_MS - (Date.now() - lastRuntimeRefreshAt),
      );
      runtimeRefreshTimer = setTimeout(() => {
        runtimeRefreshTimer = null;
        void refreshRuntime();
      }, Math.max(REFRESH_DEBOUNCE_MS, cooldownRemaining));
    };

    const flushEvents = () => {
      eventFlushTimer = null;
      const current = modelRef.current;
      const batch = eventBuffer;
      eventBuffer = [];
      if (!current || batch.length === 0 || disposed) return;
      const result = applyControlEvents(current, batch);
      commit(result.model);
      if (result.sessionRefreshRequired) scheduleSessionRefresh();
      if (result.runtimeRefreshRequired) scheduleRuntimeRefresh(result.runtimeRefreshReasons);
    };

    const queueEvent = (event: HydraEvent) => {
      eventBuffer.push(event);
      if (eventFlushTimer === null) {
        eventFlushTimer = setTimeout(flushEvents, EVENT_FLUSH_MS);
      }
    };

    const restartStreams = () => {
      if (!streamsStarted || disposed) return;
      streamsStarted = false;
      stopEvents();
      stopAttention();
      stopEvents = () => {};
      stopAttention = () => {};
      update(current => applyConnectionState(current, {
        sessionsConnected: false,
        attentionConnected: false,
      }));
      scheduleSessionRefresh();
    };

    const startStreams = (after: number) => {
      if (streamsStarted || disposed) return;
      streamsStarted = true;
      update(current => applyConnectionState(current, { sessionsConnected: true }));
      stopEvents = consume(
        client.subscribeEvents({ after }),
        queueEvent,
        (cause) => {
          update(current => applyConnectionState(current, { sessionsConnected: false }));
          reportError(cause);
          restartStreams();
        },
        restartStreams,
      );
      stopAttention = consume(
        client.subscribeNotificationOccurrencesV2({ status: 'active' }),
        (snapshot: NotificationOccurrenceSnapshotV2) => {
          update(current => applyConnectionState(
            applyNotificationOccurrenceSnapshot(current, snapshot),
            { attentionConnected: true },
          ));
        },
        (cause) => {
          update(current => applyConnectionState(current, { attentionConnected: false }));
          reportError(cause);
          restartStreams();
        },
        restartStreams,
      );
    };

    const refreshBase = async () => {
      if (disposed) return;
      if (baseRefreshInFlight) {
        baseRefreshPending = true;
        return;
      }
      baseRefreshInFlight = true;
      try {
        const [sessions, runtime] = await Promise.all([
          client.listSessions(),
          client.listWorkerRuntimeV2(),
        ]);
        if (disposed) return;
        const current = modelRef.current;
        const next = current
          ? applyRuntimeSnapshot(applySessionsSnapshot(current, sessions), runtime)
          : createDesktopControlModel(sessions, runtime);
        commit(applyConnectionState(next, { sessionsConnected: true }));
        setError(null);
        startStreams(runtime.lastEventSeq);
        pollGitStatus();
      } catch (cause) {
        update(current => applyConnectionState(current, { sessionsConnected: false }));
        reportError(cause);
      } finally {
        baseRefreshInFlight = false;
        if (baseRefreshPending && !disposed) {
          baseRefreshPending = false;
          void refreshBase();
        }
      }
    };

    function scheduleSessionRefresh(): void {
      if (sessionRefreshTimer !== null || disposed) return;
      sessionRefreshTimer = setTimeout(() => {
        sessionRefreshTimer = null;
        void refreshBase();
      }, REFRESH_DEBOUNCE_MS);
    }

    refreshRef.current = () => {
      void refreshBase();
      pollGitStatus();
    };

    void refreshBase();
    const gitTimer = setInterval(pollGitStatus, GIT_STATUS_POLL_MS);

    return () => {
      disposed = true;
      stopEvents();
      stopAttention();
      clearInterval(gitTimer);
      if (eventFlushTimer !== null) clearTimeout(eventFlushTimer);
      if (sessionRefreshTimer !== null) clearTimeout(sessionRefreshTimer);
      if (runtimeRefreshTimer !== null) clearTimeout(runtimeRefreshTimer);
      eventBuffer = [];
      refreshRef.current = () => {};
    };
  }, [client]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const view = useMemo(() => model ? selectDesktopControlView(model) : null, [model]);

  return {
    model,
    view,
    loading: model === null && error === null,
    error,
    connected: Boolean(model?.sessionsConnected && model.attentionConnected),
    refresh,
  };
}

function consume<T>(
  iterable: AsyncIterable<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  onComplete: () => void,
): () => void {
  const iterator = iterable[Symbol.asyncIterator]();
  let cancelled = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done || cancelled) {
          if (!cancelled) onComplete();
          return;
        }
        onValue(value);
      }
    } catch (cause) {
      if (!cancelled) onError(cause);
    }
  })();
  return () => {
    cancelled = true;
    void iterator.return?.().catch(() => {});
  };
}
