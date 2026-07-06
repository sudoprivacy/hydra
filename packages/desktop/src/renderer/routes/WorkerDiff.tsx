// /worker/:id/diff — the M4 Diff Review route. The route + `:id` (the session
// name) contract is fixed by the app shell; this file just hands the session to
// <DiffReview/>, which owns the whole diff experience under renderer/diff/.

import { useParams } from 'react-router-dom';

import { DiffReview } from '../diff/DiffReview';

export function WorkerDiff(): JSX.Element {
  const { id } = useParams();
  if (!id) {
    return <p className="hydra-status hydra-status--error">No worker id in the URL.</p>;
  }
  return <DiffReview session={id} />;
}
