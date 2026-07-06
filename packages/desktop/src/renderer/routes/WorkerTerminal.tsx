// /worker/:id/terminal — PLACEHOLDER. The M3 worker fills this in with the
// xterm.js view over the terminal channel (attachTerminal / the transport's
// openTerminal). Do not build it here. Route + params contract are fixed so M3
// touches mostly this file.

import { useParams } from 'react-router-dom';

export function WorkerTerminal(): JSX.Element {
  const { id } = useParams();
  return (
    <section className="hydra-placeholder">
      <h1>Terminal</h1>
      <p>
        M3 — terminal for worker <code>{id}</code> (not yet implemented).
      </p>
    </section>
  );
}
