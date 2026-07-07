// The app shell: client provider → sessions (live board + actions) → tabs
// (navigation state) → the two-pane AppLayout. Navigation is React state, not a
// URL router: the sidebar opens session tabs and the tab shell keeps them alive.

import { HydraClientProvider } from './HydraClientProvider';
import { SessionsProvider } from './sessions/SessionsProvider';
import { TabsProvider } from './tabs/TabsProvider';
import { AppLayout } from './AppLayout';

export function App(): JSX.Element {
  return (
    <HydraClientProvider>
      <SessionsProvider>
        <TabsProvider>
          <AppLayout />
        </TabsProvider>
      </SessionsProvider>
    </HydraClientProvider>
  );
}
