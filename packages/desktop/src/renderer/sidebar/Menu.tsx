// A tiny dropdown menu: an icon trigger + a popover list that closes on outside
// click or Escape. Shared by the sidebar header (＋ create, ⋯ more) and the
// per-row action menu. Clicks are contained (stopPropagation) so opening a
// row's menu never also selects/opens the row underneath it.

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  /** Accessible label + tooltip for the trigger. */
  label: string;
  glyph: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
}

export function Menu({ label, glyph, items, align = 'left', className }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`hydra-menu${open ? ' hydra-menu--open' : ''}${className ? ` ${className}` : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="hydra-iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {glyph}
      </button>
      {open ? (
        <div className={`hydra-menu__panel hydra-menu__panel--${align}`} role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`hydra-menu__item${item.danger ? ' hydra-menu__item--danger' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon ? <span className="hydra-menu__item-icon" aria-hidden="true">{item.icon}</span> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
