import { useEffect, useRef, type KeyboardEvent } from 'react';

import { useSessions } from '../sessions/SessionsProvider';
import { controlRowStatus, isAttention, STATUS_LABELS } from '../status';
import { X } from '../ui/icons';
import { tabElementId, tabPanelId, useTabs } from './TabsProvider';
import { selectTabSession } from './tabSelectors';

export function TabBar(): JSX.Element {
  const tabs = useTabs();
  const { control } = useSessions();
  const tabElements = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!tabs.activeId) return;
    tabElements.current.get(tabs.activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.activeId, tabs.tabs.length]);

  const registerTab = (id: string, element: HTMLElement | null) => {
    if (element) tabElements.current.set(id, element);
    else tabElements.current.delete(id);
  };
  const focusTabAt = (index: number) => {
    const tab = tabs.tabs[index];
    if (!tab) return;
    tabs.focusTab(tab.id);
    requestAnimationFrame(() => tabElements.current.get(tab.id)?.focus());
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    const index = tabs.tabs.findIndex(tab => tab.id === id);
    if (index < 0) return;
    let nextIndex: number | undefined;
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight') nextIndex = Math.min(tabs.tabs.length - 1, index + 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    focusTabAt(nextIndex);
  };
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
            ref={element => registerTab(tab.id, element)}
            id={tabElementId(tab.id)}
            role="tab"
            aria-selected={active}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={active ? 0 : -1}
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
              } else {
                onTabKeyDown(event, tab.id);
              }
            }}
          >
            <span className={`hydra-sdot hydra-sdot--${status}`} title={STATUS_LABELS[status]} />
            {row ? (
              <span className="hydra-tab__kind">
                {row.kind === 'worker' ? row.type.toUpperCase() : 'COPILOT'}
              </span>
            ) : null}
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
