import type { HydraNotificationV2 } from '@hydra/protocol';

import { isAttentionOccurrence, type WorkerContextModel } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import {
  ContextActions,
  ContextFacts,
  ContextSection,
  CopyValue,
  formatObservedAt,
  occurrenceKindLabel,
  runtimeLabel,
  StateDot,
} from './ContextPrimitives';

export function WorkerContext({
  context,
  onOpenDiff,
  onRouteOccurrence,
}: {
  context: WorkerContextModel;
  onOpenDiff: () => void;
  onRouteOccurrence: (occurrence: HydraNotificationV2) => void;
}): JSX.Element {
  const { actions } = useSessions();
  const { worker, parentCopilot } = context;
  const activeOccurrences = context.occurrences.filter(isAttentionOccurrence);
  return (
    <>
      <ContextSection title="Runtime">
        <div className="hydra-context__runtime-title">
          <StateDot state={worker.runtimeState} />
          <strong>{runtimeLabel(worker.runtimeState)}</strong>
        </div>
        <ContextFacts facts={[
          { label: 'Reason', value: worker.runtimeReason || 'No runtime reason' },
          { label: 'Observed', value: formatObservedAt(worker.runtime?.observedAt) },
          { label: 'Agent', value: worker.runtime?.agent || worker.agent },
        ]} />
      </ContextSection>

      <ContextSection title="Source">
        <ContextFacts facts={[
          {
            label: worker.type === 'code' ? 'Repository' : 'Local task',
            value: worker.type === 'code' ? worker.repoLabel : worker.name,
          },
          { label: 'Branch', value: worker.branch || 'Not applicable' },
          {
            label: 'Workdir',
            value: worker.workdir ? <CopyValue value={worker.workdir} /> : 'Unavailable',
            title: worker.workdir ?? undefined,
          },
          { label: 'Parent Copilot', value: parentCopilot?.name || 'None' },
        ]} />
      </ContextSection>

      {worker.type === 'code' ? (
        <ContextSection title="Changes">
          <div className="hydra-context__changes">
            <span>{worker.changed === null ? 'Change count unavailable' : `${worker.changed} changed files`}</span>
            <button type="button" className="hydra-context__text-action" onClick={onOpenDiff}>
              Open Diff
            </button>
          </div>
        </ContextSection>
      ) : null}

      <ContextSection title="Attention">
        {activeOccurrences.length > 0 ? (
          <div className="hydra-context__occurrences">
            {activeOccurrences.map(occurrence => (
              <button
                key={occurrence.occurrenceId}
                type="button"
                className={`hydra-context__occurrence hydra-context__occurrence--${occurrence.kind}`}
                onClick={() => onRouteOccurrence(occurrence)}
              >
                <span className="hydra-context__occurrence-kind">{occurrenceKindLabel(occurrence.kind)}</span>
                <strong>{occurrence.title}</strong>
                {occurrence.body ? <span>{occurrence.body}</span> : null}
              </button>
            ))}
          </div>
        ) : <p className="hydra-context__empty">No active attention.</p>}
      </ContextSection>

      <details className="hydra-context__diagnostics">
        <summary>Diagnostics</summary>
        <ContextFacts facts={[
          { label: 'Worker ID', value: worker.workerId },
          { label: 'Run ID', value: worker.runtime?.runId || 'None' },
          { label: 'Lifecycle epoch', value: worker.runtime?.lifecycleEpoch || 'Unavailable' },
          { label: 'Revision', value: worker.runtime?.revision ?? 'Unavailable' },
        ]} />
      </details>

      <ContextActions>
        <button type="button" onClick={() => actions.send(worker)}>
          <strong>Send message</strong>
          <span>Reply through the Worker lifecycle path</span>
        </button>
        {worker.lifecycle === 'running' ? (
          <button type="button" onClick={() => actions.stop(worker)}>
            <strong>Stop Worker</strong>
            <span>Keep its worktree and session metadata</span>
          </button>
        ) : (
          <button type="button" onClick={() => actions.start(worker)}>
            <strong>Start Worker</strong>
            <span>Resume this Worker session</span>
          </button>
        )}
        <button type="button" onClick={() => actions.rename(worker)}>
          <strong>Rename</strong>
          <span>Change the display and route name</span>
        </button>
        <button type="button" className="hydra-context__danger" onClick={() => actions.delete(worker)}>
          <strong>Delete</strong>
          <span>Remove this Worker after confirmation</span>
        </button>
      </ContextActions>
    </>
  );
}
