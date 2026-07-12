// The create form. One modal covers the three things you can spin up from the
// cockpit: a code worker (repo + branch), a task worker (a folder or a managed
// temp dir), and a cross-repo copilot. Field names mirror the CLI flags, so the
// payload maps 1:1 onto CreateWorkerInput / CreateCopilotInput.

import { useState, type FormEvent, type ReactNode } from 'react';

import type { CreateCopilotInput, CreateWorkerInput } from '@hydra/protocol';

import { Modal } from './Modal';

export type CreateKind = 'worker' | 'copilot';

interface CreateSessionModalProps {
  initialKind: CreateKind;
  initialCopilot?: string;
  initialWorkerType?: WorkerType;
  copilots: readonly { session: string; name: string; running: boolean }[];
  busy?: boolean;
  error?: string | null;
  onCreateWorker: (input: CreateWorkerInput) => void;
  onCreateCopilot: (input: CreateCopilotInput, initialTask?: string) => void;
  onClose: () => void;
}

type WorkerType = 'code' | 'task';

export function CreateSessionModal({
  initialKind,
  initialCopilot,
  initialWorkerType = 'code',
  copilots,
  busy = false,
  error,
  onCreateWorker,
  onCreateCopilot,
  onClose,
}: CreateSessionModalProps): JSX.Element {
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [workerType, setWorkerType] = useState<WorkerType>(initialWorkerType);

  // Shared / worker fields.
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [temp, setTemp] = useState(false);
  const [agent, setAgent] = useState('');
  const [base, setBase] = useState('');
  const [task, setTask] = useState('');
  const [copilot, setCopilot] = useState(() => (
    initialCopilot && copilots.some(item => item.session === initialCopilot)
      ? initialCopilot
      : copilots.length === 1 ? copilots[0].session : ''
  ));

  // Copilot fields.
  const [copilotWorkdir, setCopilotWorkdir] = useState('');
  const [copilotTask, setCopilotTask] = useState('');
  const [plan, setPlan] = useState(false);

  const validity = validate(kind, workerType, { repo, branch, dir, name, temp });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || validity.error) {
      return;
    }
    if (kind === 'copilot') {
      onCreateCopilot(trimObject<CreateCopilotInput>({
        workdir: copilotWorkdir,
        agent,
        name,
        plan: plan || undefined,
      }), copilotTask.trim() || undefined);
      return;
    }
    if (workerType === 'code') {
      onCreateWorker(trimObject<CreateWorkerInput>({
        repo,
        branch,
        agent,
        base,
        task,
        copilot,
      }));
      return;
    }
    onCreateWorker(trimObject<CreateWorkerInput>({
      dir: temp ? undefined : dir,
      temp: temp || undefined,
      name,
      agent,
      task,
      copilot,
    }));
  };

  return (
    <Modal title={kind === 'copilot' ? 'Create Copilot' : workerType === 'code' ? 'Create Code Worker' : 'Create Local Task'} onClose={onClose}>
      <form className="hydra-form" onSubmit={submit}>
        <div className="hydra-segmented" role="tablist" aria-label="Session kind">
          <SegButton active={kind === 'worker'} onClick={() => setKind('worker')}>
            Worker
          </SegButton>
          <SegButton active={kind === 'copilot'} onClick={() => setKind('copilot')}>
            Copilot
          </SegButton>
        </div>

        {kind === 'worker' ? (
          <>
            <div className="hydra-segmented hydra-segmented--sub" role="tablist" aria-label="Worker type">
              <SegButton active={workerType === 'code'} onClick={() => setWorkerType('code')}>
                Code (repo · branch)
              </SegButton>
              <SegButton active={workerType === 'task'} onClick={() => setWorkerType('task')}>
                Task (folder)
              </SegButton>
            </div>

            {workerType === 'code' ? (
              <>
                <Field label="Repo" required value={repo} onChange={setRepo} placeholder="owner/name or /path/to/repo" />
                <Field label="Branch" required value={branch} onChange={setBranch} placeholder="feat/my-branch" />
                <Field label="Base branch" value={base} onChange={setBase} placeholder="default: repo default branch" />
              </>
            ) : (
              <>
                <label className="hydra-checkbox">
                  <input type="checkbox" checked={temp} onChange={(event) => setTemp(event.target.checked)} />
                  <span>Managed temp folder (Hydra creates it under ~/.hydra/tasks)</span>
                </label>
                {temp ? (
                  <Field label="Name" required value={name} onChange={setName} placeholder="research" />
                ) : (
                  <>
                    <Field label="Folder" required value={dir} onChange={setDir} placeholder="~/notes" />
                    <Field label="Name" value={name} onChange={setName} placeholder="default: folder name" />
                  </>
                )}
              </>
            )}

            <Field label="Agent" value={agent} onChange={setAgent} placeholder="default agent" />
            <SelectField
              label="Parent copilot"
              value={copilot}
              onChange={setCopilot}
              options={copilots.map(item => ({
                value: item.session,
                label: `${item.name}${item.running ? '' : ' (stopped)'}`,
              }))}
              emptyLabel="Global inbox (no parent)"
              hint={copilots.length === 0 ? 'No copilots yet; attention will go to the global inbox.' : undefined}
            />
            <Field label="Task" value={task} onChange={setTask} placeholder="optional first instruction" multiline />
          </>
        ) : (
          <>
            <Field label="Workdir" value={copilotWorkdir} onChange={setCopilotWorkdir} placeholder="default: $HOME" />
            <Field label="Agent" value={agent} onChange={setAgent} placeholder="default agent" />
            <Field label="Name" value={name} onChange={setName} placeholder="optional display name" />
            <label className="hydra-checkbox">
              <input type="checkbox" checked={plan} onChange={(event) => setPlan(event.target.checked)} />
              <span>Plan mode</span>
            </label>
            <Field
              label="Initial task"
              value={copilotTask}
              onChange={setCopilotTask}
              placeholder="optional first instruction"
              multiline
            />
          </>
        )}

        {error ? <p className="hydra-form__error">{error}</p> : null}
        {validity.hint ? <p className="hydra-form__hint">{validity.hint}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hydra-btn hydra-btn--primary" disabled={busy || Boolean(validity.error)}>
            {busy
              ? 'Creating…'
              : kind === 'copilot' ? 'Create Copilot' : workerType === 'code' ? 'Create Worker' : 'Create Local Task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ValidateFields {
  repo: string;
  branch: string;
  dir: string;
  name: string;
  temp: boolean;
}

function validate(kind: CreateKind, workerType: WorkerType, fields: ValidateFields): { error: boolean; hint: string | null } {
  if (kind === 'copilot') {
    return { error: false, hint: null };
  }
  if (workerType === 'code') {
    if (!fields.repo.trim() || !fields.branch.trim()) {
      return { error: true, hint: 'Repo and branch are required for a code worker.' };
    }
    return {
      error: false,
      hint: 'Linked worktree paths resolve to their primary repository before the worker is created.',
    };
  }
  if (fields.temp) {
    if (!fields.name.trim()) {
      return { error: true, hint: 'A managed temp worker needs a name.' };
    }
    return { error: false, hint: null };
  }
  if (!fields.dir.trim()) {
    return { error: true, hint: 'A folder path is required for a task worker.' };
  }
  return { error: false, hint: null };
}

/** Trim strings, drop empties, keep booleans — the CLI-flag-shaped payload. */
function trimObject<T>(raw: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        out[key] = trimmed;
      }
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
}): JSX.Element {
  return (
    <label className="hydra-field">
      <span className="hydra-field__label">
        {label}
        {required ? <span className="hydra-field__req"> *</span> : null}
      </span>
      {multiline ? (
        <textarea
          className="hydra-field__input"
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="hydra-field__input"
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  emptyLabel,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  emptyLabel: string;
  hint?: string;
}): JSX.Element {
  return (
    <label className="hydra-field">
      <span className="hydra-field__label">{label}</span>
      <select className="hydra-field__input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {hint ? <span className="hydra-field__hint">{hint}</span> : null}
    </label>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`hydra-seg${active ? ' hydra-seg--active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
