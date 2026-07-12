import type { HydraNotificationV2 } from '@hydra/protocol';

import { isAttentionOccurrence, type WorkerContextModel } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import {
  ContextActions,
  ContextActionButton,
  ContextFacts,
  ContextSection,
  CopyValue,
  formatObservedAt,
  occurrenceKindLabel,
  runtimeDisplayLabel,
  runtimeLabel,
  StateDot,
} from './ContextPrimitives';
import { Pencil, Play, Send, Square, Trash2 } from '../ui/icons';

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
  const fullRuntimeState = runtimeLabel(worker.runtimeState);
  return (
    <>
      <ContextSection title="Runtime">
        <div className="hydra-context__runtime-title">
          <StateDot state={worker.runtimeState} />
          <strong aria-label={fullRuntimeState} title={fullRuntimeState}>
            {runtimeDisplayLabel(worker.runtimeState)}
          </strong>
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
        <ContextActionButton
          icon={<Send size={15} />}
          title="Send message"
          description="Reply through the Worker lifecycle path"
          onClick={() => actions.send(worker)}
        />
        {worker.lifecycle === 'running' ? (
          <ContextActionButton
            icon={<Square size={15} />}
            title="Stop Worker"
            description="Keep its worktree and session metadata"
            onClick={() => actions.stop(worker)}
          />
        ) : (
          <ContextActionButton
            icon={<Play size={15} />}
            title="Start Worker"
            description="Resume this Worker session"
            onClick={() => actions.start(worker)}
          />
        )}
        <ContextActionButton
          icon={<Pencil size={15} />}
          title="Rename"
          description="Change the display and route name"
          onClick={() => actions.rename(worker)}
        />
        <ContextActionButton
          icon={<Trash2 size={15} />}
          title="Delete"
          description="Remove this Worker after confirmation"
          danger
          onClick={() => actions.delete(worker)}
        />
      </ContextActions>
    </>
  );
}
