// /worker/:id/diff — PLACEHOLDER. The M4 worker fills this in with the
// path-constrained diff review (getDiff / getFileSnapshot via useHydraClient).
// Do not build it here. Route + params contract are fixed so M4 touches mostly
// this file.

import { useParams } from 'react-router-dom';

export function WorkerDiff(): JSX.Element {
  const { id } = useParams();
  return (
    <section className="hydra-placeholder">
      <h1>Diff</h1>
      <p>
        M4 — diff for worker <code>{id}</code> (not yet implemented).
      </p>
    </section>
  );
}
