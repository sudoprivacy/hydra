import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { exec as execCore } from '../core/exec';
import { shellQuote } from '../core/shell';
import { TmuxBackendCore } from '../core/tmux';
import { SessionManager } from '../core/sessionManager';
import { getHydraArchiveFile, getHydraSessionsFile } from '../core/path';

export interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface TestReport {
  results: TestResult[];
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
}

interface RunE2ETestOptions {
  filter?: string;
  agent?: string;
}

type TestFn = (opts: RunE2ETestOptions) => Promise<void>;

interface IsolatedEnvironmentContext {
  root: string;
  homeDir: string;
  hydraHome: string;
  hydraConfigPath: string;
  zdotdir: string;
  tmuxSocket: string;
  vscodeUserDataDir: string;
  activateScript: string;
  sampleInvocation: string;
}

interface ActiveIsolatedEnvironment {
  context: IsolatedEnvironmentContext;
  previousEnv: Record<ManagedEnvKey, string | undefined>;
}

interface ActiveTestEnvironment {
  isolated: ActiveIsolatedEnvironment;
  repoRoot: string;
  repositoryFullName: string;
}

interface SessionFileWorkerEntry {
  branch?: string;
}

interface SessionFileState {
  workers?: Record<string, SessionFileWorkerEntry>;
}

interface ArchiveWorkerData {
  branch?: string;
}

interface ArchiveEntry {
  type?: string;
  sessionName?: string;
  data?: ArchiveWorkerData;
}

interface ArchiveState {
  entries: ArchiveEntry[];
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const ISOLATED_RUNNER_PATH = path.join(REPO_ROOT, 'scripts', 'e2e-isolated-runner.js');
const DEFAULT_E2E_REPOSITORY_NAME = 'hydra-e2e-shared';
const TEST_PREFIX = 'test-e2e-';
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const MANAGED_ENV_KEYS = [
  'HYDRA_HOME',
  'HYDRA_CONFIG_PATH',
  'HYDRA_TMUX_SOCKET',
  'HYDRA_E2E_ROOT',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'ZDOTDIR',
  'TMUX',
  'TMUX_PANE',
] as const;

type ManagedEnvKey = typeof MANAGED_ENV_KEYS[number];

let activeTestEnvironment: ActiveTestEnvironment | null = null;

function generateId(): string {
  return Math.random().toString(36).substring(2, 8);
}

async function exec(command: string, opts?: { cwd?: string }): Promise<string> {
  return execCore(command, opts);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${Math.round(ms / 1000)}s: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function detectAgent(preferredAgent?: string): Promise<string> {
  if (preferredAgent) {
    const command = preferredAgent === 'sudocode' ? 'scode' : preferredAgent;
    try {
      await exec(`which ${command}`);
      return preferredAgent;
    } catch {
      throw new Error(`Requested agent "${preferredAgent}" is not installed or not on PATH`);
    }
  }

  for (const candidate of [
    { type: 'claude', command: 'claude' },
    { type: 'codex', command: 'codex' },
    { type: 'gemini', command: 'gemini' },
    { type: 'sudocode', command: 'scode' },
  ]) {
    try {
      await exec(`which ${candidate.command}`);
      return candidate.type;
    } catch {
      // Try the next agent.
    }
  }

  throw new Error('No agent CLI found. Install one of: claude, codex, gemini, scode');
}

async function checkPrerequisites(): Promise<void> {
  const missing: string[] = [];
  for (const command of ['tmux', 'git', 'gh', 'code']) {
    try {
      await exec(`which ${command}`);
    } catch {
      missing.push(command);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Prerequisite failed: missing commands: ${missing.join(', ')}`);
  }

  await detectAgent();

  try {
    await exec('gh auth status');
  } catch {
    throw new Error('Prerequisite failed: gh is not authenticated. Run: gh auth login');
  }
}

function getConfiguredE2ERepository(): string {
  return process.env.HYDRA_E2E_REPOSITORY?.trim() || DEFAULT_E2E_REPOSITORY_NAME;
}

async function getE2ERepositoryFullName(): Promise<string> {
  const configuredRepository = getConfiguredE2ERepository();
  if (configuredRepository.includes('/')) {
    return configuredRepository;
  }

  const login = await exec('gh api user --jq .login');
  return `${login}/${configuredRepository}`;
}

async function githubRepositoryExists(repositoryFullName: string): Promise<boolean> {
  try {
    await exec(`gh repo view ${shellQuote(repositoryFullName)} --json nameWithOwner >/dev/null`);
    return true;
  } catch {
    return false;
  }
}

async function prepareE2ERepository(cloneRoot: string): Promise<{ repositoryFullName: string; repoRoot: string }> {
  const repositoryFullName = await getE2ERepositoryFullName();
  const repoDirName = repositoryFullName.split('/').pop() || DEFAULT_E2E_REPOSITORY_NAME;
  const repoRoot = path.join(cloneRoot, repoDirName);
  const exists = await githubRepositoryExists(repositoryFullName);

  if (exists) {
    await exec(
      `gh repo clone ${shellQuote(repositoryFullName)} ${shellQuote(repoDirName)}`,
      { cwd: cloneRoot },
    );
  } else {
    await exec(
      `gh repo create ${shellQuote(repositoryFullName)} --private --add-readme --clone`,
      { cwd: cloneRoot },
    );
  }

  await exec('git config user.email "test@hydra.dev"', { cwd: repoRoot });
  await exec('git config user.name "Hydra E2E"', { cwd: repoRoot });

  return { repositoryFullName, repoRoot };
}

function captureManagedEnv(): Record<ManagedEnvKey, string | undefined> {
  return {
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
    HYDRA_TMUX_SOCKET: process.env.HYDRA_TMUX_SOCKET,
    HYDRA_E2E_ROOT: process.env.HYDRA_E2E_ROOT,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    ZDOTDIR: process.env.ZDOTDIR,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
  };
}

function restoreManagedEnv(previousEnv: Record<ManagedEnvKey, string | undefined>): void {
  for (const key of MANAGED_ENV_KEYS) {
    const previousValue = previousEnv[key];
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
}

function applyIsolatedEnvironment(context: IsolatedEnvironmentContext): ActiveIsolatedEnvironment {
  const previousEnv = captureManagedEnv();
  const hydraBinDir = path.join(context.hydraHome, 'bin');
  const shimBinDir = path.join(context.root, 'bin');
  const tmpDir = path.join(context.root, 'tmp');

  process.env.HYDRA_HOME = context.hydraHome;
  process.env.HYDRA_CONFIG_PATH = context.hydraConfigPath;
  process.env.HYDRA_TMUX_SOCKET = context.tmuxSocket;
  process.env.HYDRA_E2E_ROOT = context.root;
  process.env.PATH = [hydraBinDir, shimBinDir, previousEnv.PATH || ''].filter(Boolean).join(':');
  process.env.TMPDIR = tmpDir;
  process.env.TMP = tmpDir;
  process.env.TEMP = tmpDir;
  process.env.ZDOTDIR = context.zdotdir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  return { context, previousEnv };
}

function bootstrapIsolatedEnvironment(): ActiveIsolatedEnvironment {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-e2e-runner-'));
  const result = spawnSync(process.execPath, [
    ISOLATED_RUNNER_PATH,
    '--keep',
    '--root',
    root,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const message = stderr || stdout || `isolated runner exited with code ${result.status}`;
    throw new Error(`Failed to prepare isolated test environment: ${message}`);
  }

  const contextPath = path.join(root, 'context.json');
  if (!fs.existsSync(contextPath)) {
    throw new Error(`Isolated runner did not create ${contextPath}`);
  }

  const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) as IsolatedEnvironmentContext;
  return applyIsolatedEnvironment(context);
}

function cleanupIsolatedEnvironment(root: string): void {
  const result = spawnSync(process.execPath, [
    ISOLATED_RUNNER_PATH,
    '--cleanup',
    '--root',
    root,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function getActiveEnvironment(): ActiveTestEnvironment {
  if (!activeTestEnvironment) {
    throw new Error('E2E test environment is not initialized');
  }

  return activeTestEnvironment;
}

async function setupTestEnvironment(): Promise<ActiveTestEnvironment> {
  await checkPrerequisites();

  const isolated = bootstrapIsolatedEnvironment();
  const tempRoot = path.join(isolated.context.root, 'tmp');

  try {
    const { repositoryFullName, repoRoot } = await prepareE2ERepository(tempRoot);
    return {
      isolated,
      repoRoot,
      repositoryFullName,
    };
  } catch (error) {
    restoreManagedEnv(isolated.previousEnv);
    cleanupIsolatedEnvironment(isolated.context.root);
    throw error;
  }
}

function launchExtensionDevHost(workspacePath: string): void {
  spawn('code', [
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    workspacePath,
  ], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  }).unref();
}

async function teardownTestEnvironment(): Promise<void> {
  const environment = activeTestEnvironment;
  if (!environment) {
    return;
  }

  try {
    try {
      await exec('tmux kill-server');
    } catch {
      // The isolated tmux server may already be gone.
    }
  } finally {
    restoreManagedEnv(environment.isolated.previousEnv);
    cleanupIsolatedEnvironment(environment.isolated.context.root);
    activeTestEnvironment = null;
  }
}

function readSessions(): SessionFileState {
  const file = getHydraSessionsFile();
  if (!fs.existsSync(file)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionFileState;
}

function readArchive(): ArchiveState {
  const file = getHydraArchiveFile();
  if (!fs.existsSync(file)) {
    return { entries: [] };
  }

  return JSON.parse(fs.readFileSync(file, 'utf-8')) as ArchiveState;
}

async function pollUntil<T>(
  condition: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await condition();
    if (result) {
      return result;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timeout waiting for: ${label}`);
}

function buildDemoPrompt(repoRoot: string, branchName: string, agentType: string): string {
  const quotedRepoRoot = shellQuote(repoRoot);
  const quotedBranchName = shellQuote(branchName);
  const quotedTask = shellQuote(
    'Write a Python script called calc.py that implements a calculator function. ' +
    'But FIRST, ask me what operations to support. Wait for my answer before writing any code.',
  );

  return [
    'I want you to demo the full Hydra copilot-worker workflow. Follow these steps:',
    '',
    '1. Create a worker to write a small Python script:',
    `   hydra worker create --repo ${quotedRepoRoot} --branch ${quotedBranchName} --agent ${agentType} --task ${quotedTask}`,
    '',
    '2. The worker will ask you a clarification question about what operations to support.',
    '   Check its progress with: hydra worker logs <session>',
    "   Then answer it with: hydra worker send <session> 'Support addition and multiplication only. The function should be called calculate(a, op, b) and return the result.'",
    '',
    '3. Wait for the worker to finish implementing the code.',
    '   Check progress with: hydra worker logs <session>',
    '',
    '4. Once the worker is done, review its work:',
    '   - Check the file exists: ls <workdir>/calc.py',
    '   - Review the code: cat <workdir>/calc.py',
    '   - Verify it implements calculate(a, op, b) with + and * support',
    '',
    '5. If the code looks correct, approve and clean up:',
    '   hydra worker delete <session>',
    '',
    '6. Print a summary of what happened.',
    '',
    "Important: Use the session name and workdir from the 'hydra worker create' output.",
    'Wait at least 15-20 seconds between creating the worker and checking logs for the first time.',
  ].join('\n');
}

const test_copilot_worker_conversation: TestFn = async (opts) => {
  const environment = getActiveEnvironment();
  const backend = new TmuxBackendCore();
  const sessionManager = new SessionManager(backend);
  const branchName = `${TEST_PREFIX}demo-${generateId()}`;
  const copilotName = `${TEST_PREFIX}copilot-${generateId()}`;
  const agentType = await detectAgent(opts.agent);

  launchExtensionDevHost(environment.repoRoot);
  await sleep(3000);

  const copilotInfo = await sessionManager.createCopilotAndFinalize({
    workdir: environment.repoRoot,
    agentType,
    name: copilotName,
    sessionName: copilotName,
  });

  const prompt = buildDemoPrompt(environment.repoRoot, branchName, agentType);
  await backend.sendMessage(copilotInfo.sessionName, prompt);

  const workerSessionName = await pollUntil(() => {
    const sessions = readSessions();
    for (const [sessionName, worker] of Object.entries(sessions.workers || {})) {
      if (worker.branch === branchName) {
        return sessionName;
      }
    }
    return undefined;
  }, SCENARIO_TIMEOUT_MS, 'worker to be created by copilot');

  await pollUntil(() => {
    return readArchive().entries.find(entry => (
      entry.type === 'worker'
      && entry.sessionName === workerSessionName
      && entry.data?.branch === branchName
    ));
  }, SCENARIO_TIMEOUT_MS, 'worker to be archived after review and cleanup');

  await sessionManager.deleteCopilot(copilotInfo.sessionName);

  const liveSessions = await backend.listSessions();
  const orphanedSessions = liveSessions.filter(session => session.name.includes(TEST_PREFIX));
  assert(
    orphanedSessions.length === 0,
    `Orphan test sessions remain: ${orphanedSessions.map(session => session.name).join(', ')}`,
  );

  const archivedWorker = readArchive().entries.find(entry => (
    entry.type === 'worker'
    && entry.sessionName === workerSessionName
    && entry.data?.branch === branchName
  ));
  assert(!!archivedWorker, 'Worker should be present in archive.json');
};

const ALL_TESTS: Array<{ name: string; fn: TestFn }> = [
  { name: 'test_copilot_worker_conversation', fn: test_copilot_worker_conversation },
];

export async function runE2ETests(opts?: RunE2ETestOptions): Promise<TestReport> {
  const startTime = Date.now();
  const results: TestResult[] = [];

  let tests = ALL_TESTS;
  if (opts?.filter) {
    const filter = opts.filter.toLowerCase();
    tests = tests.filter(test => test.name.toLowerCase().includes(filter));
  }

  if (tests.length === 0) {
    return {
      results,
      passed: 0,
      failed: 0,
      total: 0,
      durationMs: Date.now() - startTime,
    };
  }

  activeTestEnvironment = await setupTestEnvironment();

  try {
    for (const test of tests) {
      const testStart = Date.now();

      try {
        await withTimeout(test.fn(opts || {}), SCENARIO_TIMEOUT_MS + 90_000, test.name);
        results.push({
          name: test.name,
          passed: true,
          durationMs: Date.now() - testStart,
        });
      } catch (error) {
        results.push({
          name: test.name,
          passed: false,
          durationMs: Date.now() - testStart,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await teardownTestEnvironment();
  }

  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;

  return {
    results,
    passed,
    failed,
    total: results.length,
    durationMs: Date.now() - startTime,
  };
}
