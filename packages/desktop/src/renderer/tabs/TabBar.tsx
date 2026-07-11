import { useSessions } from '../sessions/SessionsProvider';
import { controlRowStatus, isAttention, STATUS_LABELS } from '../status';
import { X } from '../ui/icons';
import { useTabs } from './TabsProvider';
import { selectTabSession } from './tabSelectors';

export function TabBar(): JSX.Element {
  const tabs = useTabs();
  const { control } = useSessions();
  return (
    <div className="hydra-tabbar" role="tablist" aria-label="Open sessions">
      {tabs.tabs.map(tab => {
        const active = tab.id === tabs.activeId;
        const row = selectTabSession(control.view, tab);
        const status = row ? controlRowStatus(row) : 'unknown';
        const label = row?.name ?? tab.session;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={tab.session}
            className={`hydra-tab${active ? ' hydra-tab--active' : ''}${
              isAttention(status) ? ' hydra-tab--attention' : ''
            }`}
            onClick={() => tabs.focusTab(tab.id)}
            onKeyDown={event => {
              if (event.currentTarget !== event.target) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                tabs.focusTab(tab.id);
              }
            }}
          >
            <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
            <span className="hydra-tab__label">{label}</span>
            <button
              type="button"
              className="hydra-tab__close"
              aria-label={`Close ${label}`}
              onClick={event => {
                event.stopPropagation();
                tabs.closeTab(tab.id);
              }}
            >
              <X size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
