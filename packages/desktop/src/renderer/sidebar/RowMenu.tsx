import type { SessionControlRow } from '../controlState/selectors';
import { useSessions } from '../sessions/SessionsProvider';
import { useTabs } from '../tabs/TabsProvider';
import {
  Ellipsis,
  GitCompareArrows,
  Pencil,
  Play,
  Send,
  Square,
  Terminal,
  Trash2,
} from '../ui/icons';
import { Menu, type MenuItem } from './Menu';

export function RowMenu({ row }: { row: SessionControlRow }): JSX.Element {
  const tabs = useTabs();
  const { actions } = useSessions();
  const openRow = (view: 'terminal' | 'diff') => {
    tabs.openTab(row.session, row.kind, {
      workerId: row.kind === 'worker' ? row.workerId : undefined,
      agentSessionId: row.raw.agentSessionId,
      view,
    });
  };
  const items: MenuItem[] = [{
    key: 'terminal',
    label: 'Open Terminal',
    icon: <Terminal size={14} />,
    onSelect: () => openRow('terminal'),
  }];

  if (row.kind === 'worker' && row.type === 'code') {
    items.push({
      key: 'diff',
      label: 'Open Diff',
      icon: <GitCompareArrows size={14} />,
      onSelect: () => openRow('diff'),
    });
  }

  items.push(
    { key: 'send', label: 'Send message…', icon: <Send size={14} />, onSelect: () => actions.send(row) },
    { key: 'rename', label: 'Rename…', icon: <Pencil size={14} />, onSelect: () => actions.rename(row) },
  );

  if (row.lifecycle === 'running' && row.kind === 'worker') {
    items.push({ key: 'stop', label: 'Stop', icon: <Square size={14} />, onSelect: () => actions.stop(row) });
  } else if (row.lifecycle === 'stopped') {
    items.push({ key: 'start', label: 'Start', icon: <Play size={14} />, onSelect: () => actions.start(row) });
  }

  items.push({
    key: 'delete',
    label: 'Delete…',
    icon: <Trash2 size={14} />,
    danger: true,
    onSelect: () => actions.delete(row),
  });

  return (
    <Menu
      label={`Actions for ${row.name}`}
      glyph={<Ellipsis size={15} strokeWidth={1.8} />}
      align="right"
      items={items}
      className="hydra-row__menu"
    />
  );
}
