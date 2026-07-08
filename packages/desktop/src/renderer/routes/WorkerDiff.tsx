// WorkerDiff — the M4 Diff Review view, now addressed by a `session` prop instead
// of a route param. It just hands the session to <DiffReview/>, which owns the
// whole diff experience under renderer/diff/.

import { DiffReview } from '../diff/DiffReview';

export interface WorkerDiffProps {
  session: string;
}

export function WorkerDiff({ session }: WorkerDiffProps): JSX.Element {
  if (!session) {
    return <p className="hydra-status hydra-status--error">No worker session.</p>;
  }
  return <DiffReview session={session} />;
}
