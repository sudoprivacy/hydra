import type { CopilotContextModel, WorkerControlRow } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import {
  ContextActions,
  ContextFacts,
  ContextSection,
  CopyValue,
  runtimeLabel,
  StateDot,
} from './ContextPrimitives';

export function CopilotContext({
  context,
  onOpenWorker,
  onShowHistory,
}: {
  context: CopilotContextModel;
  onOpenWorker: (worker: WorkerControlRow, view: 'terminal' | 'diff') => void;
  onShowHistory: () => void;
}): JSX.Element {
  const { actions } = useSessions();
  const { copilot, workers } = context;
  return (
    <>
      <ContextSection title="Environment">
        <ContextFacts facts={[
          { label: 'Agent', value: copilot.agent },
          { label: 'Mode', value: copilot.mode === 'plan' ? 'Plan' : 'Normal' },
          {
            label: 'Workdir',
            value: copilot.workdir ? <CopyValue value={copilot.workdir} /> : 'Unavailable',
            title: copilot.workdir ?? undefined,
          },
        ]} />
      </ContextSection>

      <ContextSection className="hydra-context__summary">
        <p>{copilot.workerCount} managed workers · {copilot.repoCount} repositories</p>
      </ContextSection>

      <ContextSection title="Managed workers">
        {workers.length > 0 ? (
          <div className="hydra-context__worker-list">
            {workers.map(worker => {
              const view = worker.completed && worker.type === 'code' ? 'diff' : 'terminal';
              return (
                <button
                  key={worker.workerId}
                  type="button"
                  className="hydra-context__worker-row"
                  onClick={() => onOpenWorker(worker, view)}
                >
                  <StateDot state={worker.runtimeState} />
                  <span className="hydra-context__worker-name">{worker.name}</span>
                  <span className="hydra-context__worker-state">{runtimeLabel(worker.runtimeState)}</span>
                  <span className="hydra-context__open-label">Open</span>
                </button>
              );
            })}
          </div>
        ) : <p className="hydra-context__empty">No managed workers.</p>}
      </ContextSection>

      <ContextActions>
        <button type="button" onClick={actions.broadcast}>
          <strong>Broadcast</strong>
          <span>Send a message to all workers</span>
        </button>
        <button
          type="button"
          onClick={() => actions.create('worker', { copilotSession: copilot.session })}
        >
          <strong>Create worker</strong>
          <span>Start with this Copilot as parent</span>
        </button>
        <button type="button" onClick={onShowHistory}>
          <strong>Attention history</strong>
          <span>View resolved and dismissed occurrences</span>
        </button>
      </ContextActions>
    </>
  );
}
