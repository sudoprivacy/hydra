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
  busy?: boolean;
  error?: string | null;
  onCreateWorker: (input: CreateWorkerInput) => void;
  onCreateCopilot: (input: CreateCopilotInput) => void;
  onClose: () => void;
}

type WorkerType = 'code' | 'task';

export function CreateSessionModal({
  initialKind,
  busy = false,
  error,
  onCreateWorker,
  onCreateCopilot,
  onClose,
}: CreateSessionModalProps): JSX.Element {
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [workerType, setWorkerType] = useState<WorkerType>('code');

  // Shared / worker fields.
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [temp, setTemp] = useState(false);
  const [agent, setAgent] = useState('');
  const [base, setBase] = useState('');
  const [task, setTask] = useState('');

  // Copilot fields.
  const [copilotWorkdir, setCopilotWorkdir] = useState('');
  const [copilotRepo, setCopilotRepo] = useState('');
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
        repo: copilotRepo,
        agent,
        name,
        plan: plan || undefined,
      }));
      return;
    }
    if (workerType === 'code') {
      onCreateWorker(trimObject<CreateWorkerInput>({
        repo,
        branch,
        agent,
        base,
        task,
      }));
      return;
    }
    onCreateWorker(trimObject<CreateWorkerInput>({
      dir: temp ? undefined : dir,
      temp: temp || undefined,
      name,
      agent,
      task,
    }));
  };

  return (
    <Modal title="Create session" onClose={onClose}>
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
            <Field label="Task" value={task} onChange={setTask} placeholder="optional first instruction" multiline />
          </>
        ) : (
          <>
            <Field label="Workdir" value={copilotWorkdir} onChange={setCopilotWorkdir} placeholder="default: $HOME" />
            <Field label="Repo" value={copilotRepo} onChange={setCopilotRepo} placeholder="optional starting repo" />
            <Field label="Agent" value={agent} onChange={setAgent} placeholder="default agent" />
            <Field label="Name" value={name} onChange={setName} placeholder="optional display name" />
            <label className="hydra-checkbox">
              <input type="checkbox" checked={plan} onChange={(event) => setPlan(event.target.checked)} />
              <span>Plan mode</span>
            </label>
          </>
        )}

        {error ? <p className="hydra-form__error">{error}</p> : null}
        {validity.hint ? <p className="hydra-form__hint">{validity.hint}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hydra-btn hydra-btn--primary" disabled={busy || Boolean(validity.error)}>
            {busy ? 'Creating…' : 'Create'}
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
    return { error: false, hint: null };
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
