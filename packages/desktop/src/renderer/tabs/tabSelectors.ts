import type { DesktopControlView, SessionControlRow } from '../controlState/selectors';
import type { Tab } from './tabState';

export function selectTabSession(
  view: DesktopControlView | null,
  tab: Tab,
): SessionControlRow | null {
  if (!view) return null;
  if (tab.sessionKind === 'worker') {
    return view.workers.find(worker => (
      tab.workerId !== undefined ? worker.workerId === tab.workerId : worker.session === tab.session
    )) ?? null;
  }
  return view.copilots.find(copilot => (
    tab.agentSessionId
      ? copilot.raw.agentSessionId === tab.agentSessionId
      : copilot.session === tab.session
  )) ?? null;
}
