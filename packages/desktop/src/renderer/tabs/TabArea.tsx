import { FirstRun } from '../shell/FirstRun';
import { SessionPane } from './SessionPane';
import { TabBar } from './TabBar';
import { useTabs } from './TabsProvider';

export function TabArea(): JSX.Element {
  const { tabs, activeId } = useTabs();
  if (tabs.length === 0 || activeId === null) return <FirstRun />;

  return (
    <div className="hydra-tabarea">
      {tabs.length > 1 ? <TabBar /> : null}
      <div className="hydra-tabarea__panes">
        {tabs.map(tab => {
          const active = tab.id === activeId;
          return (
            <div key={tab.id} className="hydra-pane" hidden={!active}>
              <SessionPane tab={tab} active={active} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
