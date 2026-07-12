import { useState, type ReactNode } from 'react';
import { Copy } from '../ui/icons';

export function ContextSection({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`hydra-context__section${className ? ` ${className}` : ''}`}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}

export function ContextFacts({
  facts,
}: {
  facts: readonly { label: string; value: ReactNode; title?: string }[];
}): JSX.Element {
  return (
    <dl className="hydra-context__facts">
      {facts.map(fact => (
        <div key={fact.label} className="hydra-context__fact">
          <dt>{fact.label}</dt>
          <dd title={fact.title}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyValue({ value, displayValue = value }: { value: string; displayValue?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="hydra-context__copy-value">
      <code>{displayValue}</code>
      <button
        type="button"
        className="hydra-context__text-action"
        aria-label={copied ? 'Copied' : 'Copy value'}
        title={copied ? 'Copied' : 'Copy value'}
        onClick={() => void copy()}
      >
        <Copy size={12} strokeWidth={1.7} aria-hidden="true" />
        <span className="hydra-visually-hidden">{copied ? 'Copied' : 'Copy value'}</span>
      </button>
    </span>
  );
}

export function ContextActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="hydra-context__actions">{children}</div>;
}

export function ContextActionButton({
  icon,
  title,
  description,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={danger ? 'hydra-context__danger' : undefined}
      onClick={onClick}
    >
      <span className="hydra-context__action-icon" aria-hidden="true">{icon}</span>
      <span className="hydra-context__action-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </button>
  );
}

export function StateDot({ state }: { state: string }): JSX.Element {
  return <span className={`hydra-context__state-dot hydra-context__state-dot--${state}`} aria-hidden="true" />;
}

export function formatObservedAt(value: string | null | undefined): string {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function runtimeLabel(state: string): string {
  return state.split('-').map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join(' ');
}

export function runtimeDisplayLabel(state: string): string {
  return state === 'unknown' ? '—' : runtimeLabel(state);
}

export function occurrenceKindLabel(kind: string): string {
  switch (kind) {
    case 'needs-input': return 'Needs input';
    case 'complete': return 'Complete';
    case 'error': return 'Error';
    case 'blocked': return 'Blocked';
    default: return 'Information';
  }
}
