// /mission-control — the M1 proof-of-life. Calls listSessions() through
// useHydraClient() and renders the worker/copilot list. This is NOT the real
// Mission Control (dense grid, live event streaming, badges) — that is M2, and
// M2 replaces the body of THIS component. The data path (useHydraClient →
// listSessions) is the contract that stays.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HydraSessionList } from '@hydra/protocol';

import { useHydraClient } from '../HydraClientProvider';

export function MissionControl(): JSX.Element {
  const client = useHydraClient();
  const [sessions, setSessions] = useState<HydraSessionList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client
      .listSessions()
      .then((list) => {
        if (active) {
          setSessions(list);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (error) {
    return <p className="hydra-status hydra-status--error">Failed to load sessions: {error}</p>;
  }
  if (!sessions) {
    return <p className="hydra-status">Loading sessions…</p>;
  }

  return (
    <section className="hydra-mission-control">
      <header>
        <h1>Mission Control</h1>
        <p>{sessions.count} session(s)</p>
      </header>

      <h2>Workers ({sessions.workers.length})</h2>
      {sessions.workers.length === 0 ? (
        <p className="hydra-empty">No workers.</p>
      ) : (
        <ul className="hydra-list">
          {sessions.workers.map((worker) => (
            <li key={worker.session} className="hydra-list__item">
              <span className="hydra-list__title">
                #{worker.number} {worker.name}
              </span>
              <span className="hydra-list__meta">
                {worker.type} · {worker.agent} · {worker.status} · {worker.runtimeState.state}
              </span>
              <span className="hydra-list__actions">
                <Link to={`/worker/${encodeURIComponent(worker.session)}/terminal`}>terminal</Link>
                <Link to={`/worker/${encodeURIComponent(worker.session)}/diff`}>diff</Link>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Copilots ({sessions.copilots.length})</h2>
      {sessions.copilots.length === 0 ? (
        <p className="hydra-empty">No copilots.</p>
      ) : (
        <ul className="hydra-list">
          {sessions.copilots.map((copilot) => (
            <li key={copilot.session} className="hydra-list__item">
              <span className="hydra-list__title">{copilot.name}</span>
              <span className="hydra-list__meta">
                {copilot.agent} · {copilot.mode} · {copilot.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
