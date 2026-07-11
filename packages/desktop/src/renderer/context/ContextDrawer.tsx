import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  HydraControlClient,
  HydraNotificationV2,
  NotificationStatus,
} from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';
import {
  selectCopilotContext,
  selectWorkerContext,
  type WorkerControlRow,
} from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';
import { AttentionContext, type AttentionHistoryRow } from './AttentionContext';
import { resolveAttentionRoute } from './attentionRouting';
import { CopilotContext } from './CopilotContext';
import { useContextUi } from './ContextState';
import { WorkerContext } from './WorkerContext';

const HISTORY_STATUSES: readonly NotificationStatus[] = ['resolved', 'superseded', 'dismissed'];

export function ContextDrawer(): JSX.Element | null {
  const client = useHydraClient();
  const { control, actions } = useSessions();
  const tabs = useTabs();
  const contextUi = useContextUi();
  const [showHistory, setShowHistory] = useState(false);
  const historyState = useAttentionHistory(
    client,
    showHistory && contextUi.open && contextUi.mode === 'attention',
  );

  useEffect(() => {
    if (!contextUi.open || contextUi.mode !== 'attention') setShowHistory(false);
  }, [contextUi.open, contextUi.mode]);

  const model = control.model;
  const copilotContext = useMemo(() => (
    model && contextUi.mode === 'copilot' && contextUi.subjectSession
      ? selectCopilotContext(model, contextUi.subjectSession)
      : null
  ), [model, contextUi.mode, contextUi.subjectSession]);
  const workerContext = useMemo(() => (
    model && contextUi.mode === 'worker' && contextUi.subjectSession
      ? selectWorkerContext(model, tabs.activeTab?.workerId ?? contextUi.subjectSession)
      : null
  ), [model, contextUi.mode, contextUi.subjectSession, tabs.activeTab?.workerId]);

  const openWorker = useCallback((worker: WorkerControlRow, view: 'terminal' | 'diff') => {
    tabs.openTab(worker.session, 'worker', {
      workerId: worker.workerId,
      agentSessionId: worker.raw.agentSessionId,
      view,
    });
    contextUi.openForSession('worker', worker.session);
  }, [tabs, contextUi]);

  const routeOccurrence = useCallback((
    occurrence: HydraNotificationV2,
    worker: WorkerControlRow | null,
  ) => {
    const route = resolveAttentionRoute(occurrence, worker);
    if (!route.session) return;
    tabs.openTab(route.session, 'worker', {
      workerId: route.workerId,
      agentSessionId: route.agentSessionId,
      view: route.view,
    });
    contextUi.openForSession('worker', route.session);
    if (route.markReadId) actions.markNotificationRead(route.markReadId);
  }, [tabs, contextUi, actions]);

  const historyRows = useMemo<AttentionHistoryRow[]>(() => {
    const workers = control.view?.workers ?? [];
    const byId = new Map(workers.map(worker => [worker.workerId, worker]));
    return historyState.occurrences.map(occurrence => ({
      occurrence,
      worker: byId.get(occurrence.workerId) ?? null,
    }));
  }, [control.view?.workers, historyState.occurrences]);

  if (!contextUi.open) return null;

  let title = 'Context';
  let content: JSX.Element;
  if (!model) {
    content = <p className="hydra-context__empty">Loading context…</p>;
  } else if (contextUi.mode === 'copilot' && copilotContext) {
    title = 'Copilot context';
    content = (
      <CopilotContext
        context={copilotContext}
        onOpenWorker={openWorker}
        onShowHistory={() => {
          setShowHistory(true);
          contextUi.openAttention();
        }}
      />
    );
  } else if (contextUi.mode === 'worker' && workerContext) {
    title = 'Worker context';
    content = (
      <WorkerContext
        context={workerContext}
        onOpenDiff={() => openWorker(workerContext.worker, 'diff')}
        onRouteOccurrence={occurrence => routeOccurrence(occurrence, workerContext.worker)}
      />
    );
  } else if (contextUi.mode === 'attention') {
    title = 'Attention';
    content = (
      <AttentionContext
        rows={control.view?.attention ?? []}
        history={historyRows}
        showHistory={showHistory}
        historyLoading={historyState.loading}
        historyError={historyState.error}
        onSetHistory={setShowHistory}
        onRoute={routeOccurrence}
      />
    );
  } else {
    content = <p className="hydra-context__empty">This session is no longer available.</p>;
  }

  return (
    <aside
      className="hydra-context"
      aria-label={title}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        contextUi.close();
      }}
    >
      <header className="hydra-context__header">
        <h2>{title}</h2>
        <button type="button" className="hydra-context__close" onClick={contextUi.close}>
          Close
        </button>
      </header>
      <div className="hydra-context__body">{content}</div>
    </aside>
  );
}

function useAttentionHistory(
  client: HydraControlClient,
  enabled: boolean,
): {
  occurrences: readonly HydraNotificationV2[];
  loading: boolean;
  error: string | null;
} {
  const [history, setHistory] = useState<readonly HydraNotificationV2[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all(HISTORY_STATUSES.map(status => (
      client.listNotificationOccurrencesV2({ status, limit: 50 })
    ))).then(results => {
      if (!active) return;
      const byOccurrenceId = new Map<string, HydraNotificationV2>();
      for (const result of results) {
        for (const occurrence of result.occurrences) {
          byOccurrenceId.set(occurrence.occurrenceId, occurrence);
        }
      }
      setHistory([...byOccurrenceId.values()].sort(compareHistoryNewestFirst));
      setLoading(false);
    }).catch(cause => {
      if (!active) return;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
    };
  }, [client, enabled]);

  return { occurrences: history, loading, error };
}

function compareHistoryNewestFirst(left: HydraNotificationV2, right: HydraNotificationV2): number {
  const leftAt = Date.parse(left.dismissedAt ?? left.resolvedAt ?? left.createdAt);
  const rightAt = Date.parse(right.dismissedAt ?? right.resolvedAt ?? right.createdAt);
  return rightAt - leftAt || left.occurrenceId.localeCompare(right.occurrenceId);
}
