// The app shell: client provider → hash router → layout → route slots.
//
// This is a SCAFFOLD. Parallel milestone workers fill one route component each,
// touching mostly their own file under routes/:
//   • /mission-control        → M2 (proof-of-life list lives here today)
//   • /worker/:id/terminal    → M3 (stub today)
//   • /worker/:id/diff        → M4 (stub today)
// HashRouter is used because the renderer loads from file:// (no history API).

import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { HydraClientProvider } from './HydraClientProvider';
import { Layout } from './Layout';
import { MissionControl } from './routes/MissionControl';
import { WorkerTerminal } from './routes/WorkerTerminal';
import { WorkerDiff } from './routes/WorkerDiff';

export function App(): JSX.Element {
  return (
    <HydraClientProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/mission-control" replace />} />
            <Route path="/mission-control" element={<MissionControl />} />
            <Route path="/worker/:id/terminal" element={<WorkerTerminal />} />
            <Route path="/worker/:id/diff" element={<WorkerDiff />} />
          </Route>
        </Routes>
      </HashRouter>
    </HydraClientProvider>
  );
}
