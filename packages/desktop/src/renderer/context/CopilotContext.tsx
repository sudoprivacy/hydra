import type { CopilotContextModel, WorkerControlRow } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import {
  ContextActions,
  ContextActionButton,
  ContextFacts,
  ContextSection,
  CopyValue,
  runtimeLabel,
  StateDot,
} from './ContextPrimitives';
import { ChevronRight, History, Megaphone, Plus } from '../ui/icons';

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
  const agent = copilot.agent
    ? `${copilot.agent[0].toUpperCase()}${copilot.agent.slice(1)}`
    : 'Unavailable';
  const workdir = copilot.workdir?.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  return (
    <>
      <ContextSection title="Environment" className="hydra-context__environment">
        <ContextFacts facts={[
          { label: 'Agent', value: agent },
          { label: 'Mode', value: copilot.mode === 'plan' ? 'Plan and execute' : 'Normal' },
          {
            label: 'Workdir',
            value: copilot.workdir ? <CopyValue value={copilot.workdir} displayValue={workdir} /> : 'Unavailable',
            title: copilot.workdir ?? undefined,
          },
        ]} />
      </ContextSection>

      <ContextSection className="hydra-context__summary">
        <p>
          {copilot.workerCount} managed worker{copilot.workerCount === 1 ? '' : 's'} ·{' '}
          {copilot.repoCount} {copilot.repoCount === 1 ? 'repository' : 'repositories'}
        </p>
      </ContextSection>

      <ContextSection title="Managed workers" className="hydra-context__managed">
        {workers.length > 0 ? (
          <div className="hydra-context__worker-list">
            {workers.map(worker => {
              const view = worker.completed && worker.type === 'code' ? 'diff' : 'terminal';
              return (
                <button
                  key={worker.workerId}
                  type="button"
                  className={`hydra-context__worker-row hydra-context__worker-row--${worker.runtimeState}`}
                  onClick={() => onOpenWorker(worker, view)}
                >
                  <StateDot state={worker.runtimeState} />
                  <span className="hydra-context__worker-name">{worker.name}</span>
                  <span className="hydra-context__worker-state">{runtimeLabel(worker.runtimeState)}</span>
                  <ChevronRight className="hydra-context__open-label" size={13} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : <p className="hydra-context__empty">No managed workers.</p>}
      </ContextSection>

      <ContextActions>
        <ContextActionButton
          icon={<Megaphone size={15} />}
          title="Broadcast"
          description="Send a message to all workers"
          onClick={actions.broadcast}
        />
        <ContextActionButton
          icon={<Plus size={15} />}
          title="Create worker"
          description="Spin up a new worker"
          onClick={() => actions.create('worker', { copilotSession: copilot.session })}
        />
        <ContextActionButton
          icon={<History size={15} />}
          title="Attention history"
          description="View recent attention events"
          onClick={onShowHistory}
        />
      </ContextActions>
    </>
  );
}
