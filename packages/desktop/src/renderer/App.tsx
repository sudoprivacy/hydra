// The app shell: client provider → sessions (live board + actions) → tabs
// (navigation state) → the two-pane AppLayout. Navigation is React state, not a
// URL router: the sidebar opens session tabs and the tab shell keeps them alive.

import { HydraClientProvider } from './HydraClientProvider';
import { DesktopControlProvider } from './controlState/useDesktopControlState';
import { ContextUiProvider } from './context/ContextState';
import { SessionsProvider } from './sessions/SessionsProvider';
import { ShellUiProvider } from './shell/shellState';
import { TabsProvider } from './tabs/TabsProvider';
import { AppLayout } from './AppLayout';

export function App(): JSX.Element {
  return (
    <HydraClientProvider>
      <DesktopControlProvider>
        <SessionsProvider>
          <ShellUiProvider>
            <TabsProvider>
              <ContextUiProvider>
                <AppLayout />
              </ContextUiProvider>
            </TabsProvider>
          </ShellUiProvider>
        </SessionsProvider>
      </DesktopControlProvider>
    </HydraClientProvider>
  );
}
