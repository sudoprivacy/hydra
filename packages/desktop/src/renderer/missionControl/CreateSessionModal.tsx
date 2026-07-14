// Focused creation forms for the three explicit sidebar entry points. The
// sidecar resolves launchable agents, recent repositories, and concrete
// defaults so the renderer does not guess at machine-specific configuration.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';

import type {
  CreateCopilotInput,
  CreationAgentOption,
  CreationOptionsResult,
  CreationRepositoryOption,
  CreateWorkerInput,
} from '@hydra/protocol';

import {
  chooseInitialRepository,
  MANUAL_REPOSITORY,
  suggestBranchFromTask,
} from './creationFormModel';
import { Modal } from './Modal';

export type CreateKind = 'worker' | 'copilot';
type WorkerType = 'code' | 'task';

interface CreateSessionModalProps {
  initialKind: CreateKind;
  initialCopilot?: string;
  initialRepo?: string;
  initialWorkerType?: WorkerType;
  creationOptions: CreationOptionsResult | null;
  optionsLoading?: boolean;
  optionsError?: string | null;
  copilots: readonly { session: string; name: string; running: boolean }[];
  busy?: boolean;
  error?: string | null;
  onCreateWorker: (input: CreateWorkerInput) => void;
  onCreateCopilot: (input: CreateCopilotInput, initialTask?: string) => void;
  onClose: () => void;
}

export function CreateSessionModal({
  initialKind,
  initialCopilot,
  initialRepo,
  initialWorkerType = 'code',
  creationOptions,
  optionsLoading = false,
  optionsError,
  copilots,
  busy = false,
  error,
  onCreateWorker,
  onCreateCopilot,
  onClose,
}: CreateSessionModalProps): JSX.Element {
  const [repoChoice, setRepoChoice] = useState(MANUAL_REPOSITORY);
  const [manualRepo, setManualRepo] = useState(initialRepo ?? '');
  const repoInitialized = useRef(false);
  const [branch, setBranch] = useState(() => suggestBranchFromTask(''));
  const [branchTouched, setBranchTouched] = useState(false);
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [temp, setTemp] = useState(false);
  const [agent, setAgent] = useState('');
  const [base, setBase] = useState('');
  const [customBase, setCustomBase] = useState(false);
  const [task, setTask] = useState('');
  const [copilot, setCopilot] = useState(() => (
    initialCopilot && copilots.some(item => item.session === initialCopilot)
      ? initialCopilot
      : copilots.length === 1 ? copilots[0].session : ''
  ));

  const [copilotWorkdir, setCopilotWorkdir] = useState('');
  const [workdirTouched, setWorkdirTouched] = useState(false);
  const [copilotTask, setCopilotTask] = useState('');
  const [plan, setPlan] = useState(false);

  const selectedAgent = creationOptions?.agents.find(option => option.id === agent);
  const selectedRepository = creationOptions?.repositories.find(option => option.value === repoChoice);
  const repo = repoChoice === MANUAL_REPOSITORY ? manualRepo : repoChoice;

  useEffect(() => {
    if (!creationOptions) return;

    setAgent(current => current || creationOptions.defaultAgent);
    if (!workdirTouched) {
      setCopilotWorkdir(current => current || creationOptions.homeDir);
    }

    if (!repoInitialized.current) {
      setRepoChoice(chooseInitialRepository(creationOptions.repositories, initialRepo));
      if (initialRepo) setManualRepo(initialRepo);
      repoInitialized.current = true;
    }
  }, [creationOptions, initialRepo, workdirTouched]);

  useEffect(() => {
    if (plan && selectedAgent && !selectedAgent.supportsPlanMode) {
      setPlan(false);
    }
  }, [plan, selectedAgent]);

  useEffect(() => {
    if (initialKind !== 'copilot' || nameTouched || !selectedAgent) return;
    setName(plan ? selectedAgent.suggestedPlanName : selectedAgent.suggestedCopilotName);
  }, [initialKind, nameTouched, plan, selectedAgent]);

  const validity = validate(initialKind, initialWorkerType, {
    repo,
    branch,
    dir,
    name,
    temp,
    selectedAgent,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || optionsLoading || validity.error) return;

    if (initialKind === 'copilot') {
      onCreateCopilot(trimObject<CreateCopilotInput>({
        workdir: copilotWorkdir,
        agent,
        name,
        plan: plan || undefined,
      }), copilotTask.trim() || undefined);
      return;
    }

    if (initialWorkerType === 'code') {
      onCreateWorker(trimObject<CreateWorkerInput>({
        repo,
        branch,
        agent,
        base: customBase ? base : undefined,
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

  const title = initialKind === 'copilot'
    ? 'Create Copilot'
    : initialWorkerType === 'code' ? 'Create Code Worker' : 'Create Local Task';
  const actionLabel = initialKind === 'copilot'
    ? 'Create Copilot'
    : initialWorkerType === 'code' ? 'Create Worker' : 'Create Local Task';

  return (
    <Modal title={title} onClose={onClose}>
      <form className="hydra-form" onSubmit={submit}>
        {initialKind === 'copilot' ? (
          <CopilotFields
            name={name}
            onNameChange={(value) => {
              setNameTouched(true);
              setName(value);
            }}
            agent={agent}
            onAgentChange={setAgent}
            plan={plan}
            onPlanChange={setPlan}
            task={copilotTask}
            onTaskChange={setCopilotTask}
            workdir={copilotWorkdir}
            onWorkdirChange={(value) => {
              setWorkdirTouched(true);
              setCopilotWorkdir(value);
            }}
            selectedAgent={selectedAgent}
            creationOptions={creationOptions}
            optionsLoading={optionsLoading}
            optionsError={optionsError}
          />
        ) : initialWorkerType === 'code' ? (
          <CodeWorkerFields
            repo={repo}
            repoChoice={repoChoice}
            onRepoChoiceChange={setRepoChoice}
            manualRepo={manualRepo}
            onManualRepoChange={setManualRepo}
            selectedRepository={selectedRepository}
            task={task}
            onTaskChange={(value) => {
              setTask(value);
              if (!branchTouched) setBranch(suggestBranchFromTask(value));
            }}
            branch={branch}
            onBranchChange={(value) => {
              setBranchTouched(true);
              setBranch(value);
            }}
            agent={agent}
            onAgentChange={setAgent}
            copilot={copilot}
            onCopilotChange={setCopilot}
            copilots={copilots}
            customBase={customBase}
            onCustomBaseChange={setCustomBase}
            base={base}
            onBaseChange={setBase}
            selectedAgent={selectedAgent}
            creationOptions={creationOptions}
            optionsLoading={optionsLoading}
            optionsError={optionsError}
          />
        ) : (
          <TaskWorkerFields
            temp={temp}
            onTempChange={setTemp}
            dir={dir}
            onDirChange={setDir}
            name={name}
            onNameChange={setName}
            task={task}
            onTaskChange={setTask}
            agent={agent}
            onAgentChange={setAgent}
            copilot={copilot}
            onCopilotChange={setCopilot}
            copilots={copilots}
            selectedAgent={selectedAgent}
            creationOptions={creationOptions}
            optionsLoading={optionsLoading}
            optionsError={optionsError}
          />
        )}

        {error ? <p className="hydra-form__error" role="alert">{error}</p> : null}
        {validity.hint ? <p className="hydra-form__hint">{validity.hint}</p> : null}
        <div className="hydra-form__actions">
          <button type="button" className="hydra-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="hydra-btn hydra-btn--primary"
            disabled={busy || optionsLoading || Boolean(validity.error)}
          >
            {busy ? 'Creating…' : optionsLoading ? 'Loading defaults…' : actionLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CopilotFields({
  name,
  onNameChange,
  agent,
  onAgentChange,
  plan,
  onPlanChange,
  task,
  onTaskChange,
  workdir,
  onWorkdirChange,
  selectedAgent,
  creationOptions,
  optionsLoading,
  optionsError,
}: {
  name: string;
  onNameChange: (value: string) => void;
  agent: string;
  onAgentChange: (value: string) => void;
  plan: boolean;
  onPlanChange: (value: boolean) => void;
  task: string;
  onTaskChange: (value: string) => void;
  workdir: string;
  onWorkdirChange: (value: string) => void;
  selectedAgent?: CreationAgentOption;
  creationOptions: CreationOptionsResult | null;
  optionsLoading: boolean;
  optionsError?: string | null;
}): JSX.Element {
  return (
    <>
      <p className="hydra-form__intro">
        A Copilot coordinates workers across repositories. Its starting folder does not limit its scope.
      </p>
      <Field label="Name" value={name} onChange={onNameChange} placeholder="hydra-copilot" autoFocus />
      <div className="hydra-form__grid">
        <AgentField
          value={agent}
          onChange={onAgentChange}
          selectedAgent={selectedAgent}
          creationOptions={creationOptions}
          optionsLoading={optionsLoading}
          optionsError={optionsError}
        />
        <SelectField
          label="Mode"
          value={plan ? 'plan' : 'normal'}
          onChange={value => onPlanChange(value === 'plan')}
          options={[
            { value: 'normal', label: 'Normal' },
            {
              value: 'plan',
              label: selectedAgent?.supportsPlanMode === false ? 'Plan — Unsupported' : 'Plan',
              disabled: selectedAgent?.supportsPlanMode === false,
            },
          ]}
          hint={selectedAgent && !selectedAgent.supportsPlanMode
            ? `${selectedAgent.label} does not support plan mode.`
            : 'Plan mode starts with a planning-only instruction set.'}
        />
      </div>
      <Field
        label="Initial task"
        value={task}
        onChange={onTaskChange}
        placeholder="Optional first instruction"
        multiline
      />
      <details className="hydra-form__advanced">
        <summary>Advanced</summary>
        <div className="hydra-form__advanced-body">
          <Field
            label="Starting folder"
            value={workdir}
            onChange={onWorkdirChange}
            placeholder="Default: $HOME"
            hint="Only the Copilot terminal starts here; workers may live in any repository or folder."
          />
        </div>
      </details>
    </>
  );
}

function CodeWorkerFields({
  repo,
  repoChoice,
  onRepoChoiceChange,
  manualRepo,
  onManualRepoChange,
  selectedRepository,
  task,
  onTaskChange,
  branch,
  onBranchChange,
  agent,
  onAgentChange,
  copilot,
  onCopilotChange,
  copilots,
  customBase,
  onCustomBaseChange,
  base,
  onBaseChange,
  selectedAgent,
  creationOptions,
  optionsLoading,
  optionsError,
}: {
  repo: string;
  repoChoice: string;
  onRepoChoiceChange: (value: string) => void;
  manualRepo: string;
  onManualRepoChange: (value: string) => void;
  selectedRepository?: CreationRepositoryOption;
  task: string;
  onTaskChange: (value: string) => void;
  branch: string;
  onBranchChange: (value: string) => void;
  agent: string;
  onAgentChange: (value: string) => void;
  copilot: string;
  onCopilotChange: (value: string) => void;
  copilots: readonly { session: string; name: string; running: boolean }[];
  customBase: boolean;
  onCustomBaseChange: (value: boolean) => void;
  base: string;
  onBaseChange: (value: string) => void;
  selectedAgent?: CreationAgentOption;
  creationOptions: CreationOptionsResult | null;
  optionsLoading: boolean;
  optionsError?: string | null;
}): JSX.Element {
  const repositoryOptions = creationOptions?.repositories.map(option => ({
    value: option.value,
    label: `${option.label}${option.sources.includes('recent') ? ' — Recent' : ''}`,
  })) ?? [];
  const defaultBranch = selectedRepository?.defaultBranch;

  return (
    <>
      <p className="hydra-form__intro">
        Creates a branch in an isolated git worktree and starts an agent there.
      </p>
      <SelectField
        label="Repository"
        value={repoChoice}
        onChange={onRepoChoiceChange}
        options={[
          ...repositoryOptions,
          { value: MANUAL_REPOSITORY, label: 'Enter another repository…' },
        ]}
        required
        autoFocus
        hint={optionsLoading
          ? 'Loading recent and registered repositories…'
          : repositoryOptions.length === 0 ? 'Enter a local path or owner/name.' : undefined}
      />
      {repoChoice === MANUAL_REPOSITORY ? (
        <Field
          label="Repository path or name"
          value={manualRepo}
          onChange={onManualRepoChange}
          placeholder="owner/name or /path/to/repo"
          required
        />
      ) : null}
      <Field
        label="Task"
        value={task}
        onChange={onTaskChange}
        placeholder="What should this worker do?"
        multiline
        hint="The task generates a branch suggestion until you edit the branch."
      />
      <Field
        label="Branch"
        value={branch}
        onChange={onBranchChange}
        placeholder="feat/my-task"
        required
      />
      <div className="hydra-form__grid">
        <AgentField
          value={agent}
          onChange={onAgentChange}
          selectedAgent={selectedAgent}
          creationOptions={creationOptions}
          optionsLoading={optionsLoading}
          optionsError={optionsError}
        />
        <ParentCopilotField
          value={copilot}
          onChange={onCopilotChange}
          copilots={copilots}
        />
      </div>
      <details className="hydra-form__advanced">
        <summary>Advanced</summary>
        <div className="hydra-form__advanced-body">
          <label className="hydra-checkbox">
            <input
              type="checkbox"
              checked={customBase}
              onChange={event => onCustomBaseChange(event.target.checked)}
            />
            <span>Override repository base branch</span>
          </label>
          {customBase ? (
            <Field
              label="Base branch"
              value={base}
              onChange={onBaseChange}
              placeholder={defaultBranch ?? 'main'}
              required
            />
          ) : (
            <p className="hydra-field__meta">
              Base branch: <strong>{defaultBranch ?? (repo ? 'Repository default' : 'Select a repository')}</strong>
            </p>
          )}
        </div>
      </details>
    </>
  );
}

function TaskWorkerFields({
  temp,
  onTempChange,
  dir,
  onDirChange,
  name,
  onNameChange,
  task,
  onTaskChange,
  agent,
  onAgentChange,
  copilot,
  onCopilotChange,
  copilots,
  selectedAgent,
  creationOptions,
  optionsLoading,
  optionsError,
}: {
  temp: boolean;
  onTempChange: (value: boolean) => void;
  dir: string;
  onDirChange: (value: string) => void;
  name: string;
  onNameChange: (value: string) => void;
  task: string;
  onTaskChange: (value: string) => void;
  agent: string;
  onAgentChange: (value: string) => void;
  copilot: string;
  onCopilotChange: (value: string) => void;
  copilots: readonly { session: string; name: string; running: boolean }[];
  selectedAgent?: CreationAgentOption;
  creationOptions: CreationOptionsResult | null;
  optionsLoading: boolean;
  optionsError?: string | null;
}): JSX.Element {
  return (
    <>
      <p className="hydra-form__intro">
        Starts an agent in a folder without creating a git branch or worktree.
      </p>
      <label className="hydra-checkbox">
        <input type="checkbox" checked={temp} onChange={event => onTempChange(event.target.checked)} />
        <span>Use a Hydra-managed folder under ~/.hydra/tasks</span>
      </label>
      {temp ? (
        <Field
          label="Task name"
          value={name}
          onChange={onNameChange}
          placeholder="research"
          required
          autoFocus
        />
      ) : (
        <div className="hydra-form__grid">
          <Field
            label="Folder"
            value={dir}
            onChange={onDirChange}
            placeholder="~/notes"
            required
            autoFocus
          />
          <Field
            label="Name"
            value={name}
            onChange={onNameChange}
            placeholder="Default: folder name"
          />
        </div>
      )}
      <Field
        label="Initial task"
        value={task}
        onChange={onTaskChange}
        placeholder="Optional first instruction"
        multiline
      />
      <div className="hydra-form__grid">
        <AgentField
          value={agent}
          onChange={onAgentChange}
          selectedAgent={selectedAgent}
          creationOptions={creationOptions}
          optionsLoading={optionsLoading}
          optionsError={optionsError}
        />
        <ParentCopilotField
          value={copilot}
          onChange={onCopilotChange}
          copilots={copilots}
        />
      </div>
    </>
  );
}

function AgentField({
  value,
  onChange,
  selectedAgent,
  creationOptions,
  optionsLoading,
  optionsError,
}: {
  value: string;
  onChange: (value: string) => void;
  selectedAgent?: CreationAgentOption;
  creationOptions: CreationOptionsResult | null;
  optionsLoading: boolean;
  optionsError?: string | null;
}): JSX.Element {
  const options = creationOptions?.agents.map(option => ({
    value: option.id,
    label: [option.label, option.isDefault ? 'Default' : '', option.available ? '' : 'Not found']
      .filter(Boolean)
      .join(' — '),
    disabled: !option.available,
  })) ?? [];
  const hint = optionsLoading
    ? 'Resolving installed agents…'
    : optionsError
      ? `Could not load agent choices. Hydra will use its configured default. ${optionsError}`
      : selectedAgent && !selectedAgent.available
        ? `${selectedAgent.label} is configured but was not found on PATH.`
        : undefined;

  return (
    <SelectField
      label="Agent"
      value={value}
      onChange={onChange}
      options={options}
      emptyLabel={optionsLoading ? 'Loading agents…' : 'Configured default agent'}
      required={options.length > 0}
      disabled={optionsLoading}
      hint={hint}
    />
  );
}

function ParentCopilotField({
  value,
  onChange,
  copilots,
}: {
  value: string;
  onChange: (value: string) => void;
  copilots: readonly { session: string; name: string; running: boolean }[];
}): JSX.Element {
  return (
    <SelectField
      label="Parent Copilot"
      value={value}
      onChange={onChange}
      options={copilots.map(item => ({
        value: item.session,
        label: `${item.name}${item.running ? '' : ' — Stopped'}`,
      }))}
      emptyLabel="Global inbox"
      hint={copilots.length === 0 ? 'No Copilots yet; attention goes to the global inbox.' : undefined}
    />
  );
}

interface ValidateFields {
  repo: string;
  branch: string;
  dir: string;
  name: string;
  temp: boolean;
  selectedAgent?: CreationAgentOption;
}

function validate(
  kind: CreateKind,
  workerType: WorkerType,
  fields: ValidateFields,
): { error: boolean; hint: string | null } {
  if (fields.selectedAgent && !fields.selectedAgent.available) {
    return { error: true, hint: `Install ${fields.selectedAgent.label} or choose an available agent.` };
  }
  if (kind === 'copilot') return { error: false, hint: null };
  if (workerType === 'code') {
    if (!fields.repo.trim() || !fields.branch.trim()) {
      return { error: true, hint: 'Repository and branch are required.' };
    }
    return { error: false, hint: null };
  }
  if (fields.temp && !fields.name.trim()) {
    return { error: true, hint: 'A Hydra-managed task folder needs a name.' };
  }
  if (!fields.temp && !fields.dir.trim()) {
    return { error: true, hint: 'Choose the folder where this task should run.' };
  }
  return { error: false, hint: null };
}

/** Trim strings, drop empties, keep booleans — the CLI-flag-shaped payload. */
function trimObject<T>(raw: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
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
  hint,
  required = false,
  multiline = false,
  autoFocus = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const hintId = useId();
  const sharedProps = {
    className: 'hydra-field__input',
    placeholder,
    value,
    required,
    disabled,
    'aria-required': required || undefined,
    'aria-describedby': hint ? hintId : undefined,
    'data-hydra-autofocus': autoFocus ? 'true' : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => (
      onChange(event.target.value)
    ),
  };

  return (
    <label className="hydra-field">
      <span className="hydra-field__label">
        {label}
        {required ? <span className="hydra-field__req" aria-hidden="true"> *</span> : null}
      </span>
      {multiline ? (
        <textarea {...sharedProps} rows={2} />
      ) : (
        <input {...sharedProps} type="text" autoComplete="off" />
      )}
      {hint ? <span id={hintId} className="hydra-field__hint">{hint}</span> : null}
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
  required = false,
  disabled = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  emptyLabel?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}): JSX.Element {
  const hintId = useId();
  return (
    <label className="hydra-field">
      <span className="hydra-field__label">
        {label}
        {required ? <span className="hydra-field__req" aria-hidden="true"> *</span> : null}
      </span>
      <select
        className="hydra-field__input"
        value={value}
        required={required}
        disabled={disabled}
        aria-required={required || undefined}
        aria-describedby={hint ? hintId : undefined}
        data-hydra-autofocus={autoFocus ? 'true' : undefined}
        onChange={event => onChange(event.target.value)}
      >
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map(option => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
      {hint ? <span id={hintId} className="hydra-field__hint">{hint}</span> : null}
    </label>
  );
}
