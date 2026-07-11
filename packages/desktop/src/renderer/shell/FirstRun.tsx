import { useSessions } from '../sessions/SessionsProvider';

export function FirstRun(): JSX.Element {
  const { control, actions } = useSessions();
  const hasCopilots = (control.view?.copilots.length ?? 0) > 0;

  return (
    <main className="hydra-first-run">
      <div className="hydra-first-run__content">
        <span className="hydra-first-run__eyebrow">Hydra command center</span>
        <h1>{hasCopilots ? 'Select a live session' : 'Create your first Copilot'}</h1>
        <p>
          {hasCopilots
            ? 'Choose a Copilot or Worker from the sidebar to open its live terminal.'
            : 'Copilots coordinate Workers across repositories while you stay in the real agent CLI.'}
        </p>
        {!hasCopilots ? (
          <div className="hydra-first-run__actions">
            <button type="button" className="hydra-btn hydra-btn--primary" onClick={() => actions.create('copilot')}>
              New Copilot
            </button>
            <button type="button" className="hydra-btn" onClick={() => actions.create('worker')}>
              Create Worker without a Copilot
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
