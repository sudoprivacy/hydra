import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { TmuxBackendCore } from '@hydra/core/tmux';
import { isDirectoryWorker, SessionManager, type CopilotInfo, type WorkerInfo } from '@hydra/core/sessionManager';
import {
  branchNameToSlug,
  ensureWorktreesDir,
  getRepoName,
  getRepoRootFromPath,
  listWorktrees,
} from '@hydra/core/git';
import { exec } from '@hydra/core/exec';
import { shellQuote } from '@hydra/core/shell';
import { getHydraConfig, resolveAgentSessionFile, toCanonicalPath, updateHydraConfig } from '@hydra/core/path';
import { resolveRepoInput } from '@hydra/core/repoRegistry';
import { createShareBundle, readBundle, writeBundle, type ShareableSession } from '../../share/bundle';
import {
  buildDefaultPublicBaseUrl,
  buildGcsBundleUrl,
  buildPublicHttpBundleUrl,
  downloadBundle,
  downloadHttpBundle,
  isHttpBundleUrl,
  normalizeGcsBucket,
  resolveShareRef,
  stripSlashes,
  uploadBundle,
} from '../../share/gcpStorage';
import { importCodexNativeSession } from '../../share/codexAdapter';
import { ensureLocalBranchFromRemote, validateRepoMatch } from '../../share/repo';
import type { HydraShareBundle, ShareHydraWorkerInfo } from '../../share/types';
import { outputError, outputResult, type OutputOpts } from '../output';
import { WorkerLifecycleService } from '@hydra/core/workerLifecycleService';

interface CreateShareOpts {
  bucket?: string;
  prefix?: string;
  out?: string;
  stop?: boolean;
  yes?: boolean;
}

interface AcceptShareOpts {
  bucket?: string;
  prefix?: string;
  repo: string;
  session?: string;
  agentCommand?: string;
  force?: boolean;
  allowMismatch?: boolean;
}

interface ShareConfigOpts {
  bucket?: string;
  prefix?: string;
  public?: boolean;
  publicBaseUrl?: string;
  clear?: boolean;
}

function expandPath(inputPath: string): string {
  return toCanonicalPath(inputPath) || path.resolve(inputPath);
}

function getConfiguredSharePrefix(override?: string): string {
  return stripSlashes(override || getHydraConfig().share?.prefix || 'shares');
}

function getConfiguredShareBucket(override?: string): string | undefined {
  const bucket = override || getHydraConfig().share?.bucket;
  return bucket ? normalizeGcsBucket(bucket) : undefined;
}

function getConfiguredPublicBaseUrl(): string | undefined {
  const publicBaseUrl = getHydraConfig().share?.publicBaseUrl?.trim();
  return publicBaseUrl ? publicBaseUrl.replace(/\/+$/, '') : undefined;
}

function isPathLikeShareRef(shareRef: string): boolean {
  const trimmed = shareRef.trim();
  return path.isAbsolute(trimmed)
    || trimmed.startsWith('.')
    || trimmed.startsWith('~')
    || trimmed.includes('/')
    || trimmed.includes('\\');
}

function findShareableSession(
  state: Awaited<ReturnType<SessionManager['sync']>>,
  sessionName: string,
): ShareableSession | null {
  const copilot = state.copilots[sessionName];
  if (copilot) {
    return { type: 'copilot', data: copilot };
  }

  const worker = state.workers[sessionName];
  if (worker) {
    return { type: 'worker', data: worker };
  }

  return null;
}

function warnUnencrypted(globalOpts: OutputOpts, yes?: boolean): void {
  if (!globalOpts.quiet && !yes) {
    console.error(
      'Warning: Hydra share bundles are not encrypted yet. Anyone with access to this GCS object can read the Codex session contents.',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForNativeSessionFile(
  session: ShareableSession,
  timeoutMs = 30000,
): Promise<string | null> {
  const sessionId = session.data.sessionId;
  if (!sessionId) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessionFile = resolveAgentSessionFile(session.data.agent, session.data.workdir, sessionId);
    if (sessionFile) {
      return sessionFile;
    }
    await sleep(1000);
  }

  return resolveAgentSessionFile(session.data.agent, session.data.workdir, sessionId);
}

async function stopSessionForExport(
  backend: TmuxBackendCore,
  session: ShareableSession,
): Promise<void> {
  await backend.sendMessage(session.data.sessionName, '/quit');
  const sessionFile = await waitForNativeSessionFile(session);
  if (!sessionFile) {
    throw new Error(
      `Timed out waiting for Codex to flush native session data for "${session.data.sessionName}". ` +
      'Try again after the agent has exited.',
    );
  }
}

async function writeTempBundle(bundle: Awaited<ReturnType<typeof createShareBundle>>): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydra-share-'));
  const bundlePath = path.join(tempDir, 'bundle.json');
  writeBundle(bundlePath, bundle);
  return bundlePath;
}

function resolveOutputPath(outputPath: string): string {
  return expandPath(outputPath);
}

async function downloadTempBundle(gcsUrl: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydra-share-'));
  const bundlePath = path.join(tempDir, 'bundle.json');
  await downloadBundle(gcsUrl, bundlePath);
  return bundlePath;
}

async function downloadTempHttpBundle(url: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydra-share-'));
  const bundlePath = path.join(tempDir, 'bundle.json');
  await downloadHttpBundle(url, bundlePath);
  return bundlePath;
}

async function resolveBundleInput(shareRef: string, opts: AcceptShareOpts): Promise<{ bundlePath: string; source: string }> {
  const trimmedShareRef = shareRef.trim();

  if (isHttpBundleUrl(trimmedShareRef)) {
    return {
      bundlePath: await downloadTempHttpBundle(trimmedShareRef),
      source: trimmedShareRef,
    };
  }

  if (trimmedShareRef.startsWith('gs://') || opts.bucket) {
    const gcsUrl = resolveShareRef(trimmedShareRef, {
      bucket: opts.bucket,
      prefix: getConfiguredSharePrefix(opts.prefix),
    });
    return {
      bundlePath: await downloadTempBundle(gcsUrl),
      source: gcsUrl,
    };
  }

  if (isPathLikeShareRef(trimmedShareRef)) {
    const bundlePath = expandPath(trimmedShareRef);
    if (!fs.existsSync(bundlePath)) {
      throw new Error(`Share bundle file not found: ${bundlePath}`);
    }
    return { bundlePath, source: bundlePath };
  }

  const publicBaseUrl = getConfiguredPublicBaseUrl();
  if (publicBaseUrl) {
    const publicUrl = buildPublicHttpBundleUrl({
      publicBaseUrl,
      prefix: getConfiguredSharePrefix(opts.prefix),
      shareId: trimmedShareRef,
    });
    return {
      bundlePath: await downloadTempHttpBundle(publicUrl),
      source: publicUrl,
    };
  }

  const configuredBucket = getConfiguredShareBucket();
  if (configuredBucket) {
    const gcsUrl = resolveShareRef(trimmedShareRef, {
      bucket: configuredBucket,
      prefix: getConfiguredSharePrefix(opts.prefix),
    });
    return {
      bundlePath: await downloadTempBundle(gcsUrl),
      source: gcsUrl,
    };
  }

  const bundlePath = expandPath(trimmedShareRef);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Share bundle file not found: ${bundlePath}. ` +
      'Pass --bucket <bucket>, use an https:// URL, or run `hydra share config --bucket <bucket>` first.',
    );
  }
  return { bundlePath, source: bundlePath };
}

async function ensureWorkerWorktree(
  repoRoot: string,
  worker: ShareHydraWorkerInfo,
  backend: TmuxBackendCore,
): Promise<{ workdir: string; slug: string }> {
  await ensureLocalBranchFromRemote(repoRoot, worker.branch);

  const worktrees = await listWorktrees(repoRoot);
  const existing = worktrees.find(worktree => worktree.branch === worker.branch);
  if (existing) {
    return { workdir: existing.path, slug: worker.slug || branchNameToSlug(worker.branch, backend) };
  }

  const worktreesDir = await ensureWorktreesDir(repoRoot);
  const baseSlug = worker.slug || branchNameToSlug(worker.branch, backend);
  let slug = baseSlug;
  let worktreePath = path.join(worktreesDir, slug);
  let suffix = 1;
  while (fs.existsSync(worktreePath)) {
    suffix++;
    slug = `${baseSlug}-${suffix}`;
    worktreePath = path.join(worktreesDir, slug);
  }

  await exec(`git worktree add ${shellQuote(worktreePath)} ${shellQuote(worker.branch)}`, { cwd: repoRoot });
  return { workdir: worktreePath, slug };
}

function buildImportedWorkerInfo(
  source: ShareHydraWorkerInfo,
  bundleSession: HydraShareBundle['hydraSession'],
  repoRoot: string,
  workdir: string,
  slug: string,
  sessionName: string,
): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'repo',
    sessionName,
    displayName: bundleSession.displayName || slug,
    workerId: source.workerId,
    repo: getRepoName(repoRoot),
    repoRoot,
    branch: source.branch,
    slug,
    status: 'stopped',
    attached: false,
    agent: 'codex',
    workdir,
    managedWorkdir: false,
    tmuxSession: sessionName,
    createdAt: now,
    lastSeenAt: now,
    sessionId: bundleSession.agentSessionId,
    copilotSessionName: null,
  };
}

async function acceptCopilot(
  sm: SessionManager,
  backend: TmuxBackendCore,
  bundle: HydraShareBundle,
  repoRoot: string,
  opts: AcceptShareOpts,
): Promise<CopilotInfo> {
  const sessionName = backend.sanitizeSessionName(opts.session || bundle.hydraSession.sessionName);
  return sm.createCopilotAndFinalize({
    workdir: repoRoot,
    agentType: 'codex',
    name: opts.session ? sessionName : bundle.hydraSession.displayName,
    sessionName,
    agentCommand: opts.agentCommand,
    resumeSessionId: bundle.hydraSession.agentSessionId,
  });
}

async function acceptWorker(
  lifecycle: WorkerLifecycleService,
  backend: TmuxBackendCore,
  bundle: HydraShareBundle,
  repoRoot: string,
  opts: AcceptShareOpts,
): Promise<WorkerInfo> {
  const worker = bundle.hydraSession.worker;
  if (!worker) {
    throw new Error('Worker share bundle is missing worker metadata');
  }

  const { workdir, slug } = await ensureWorkerWorktree(repoRoot, worker, backend);
  const sessionName = backend.sanitizeSessionName(opts.session || bundle.hydraSession.sessionName);
  const preservedWorkerInfo = buildImportedWorkerInfo(
    worker,
    bundle.hydraSession,
    repoRoot,
    workdir,
    slug,
    sessionName,
  );

  const { workerInfo, postCreatePromise } = await lifecycle.createWorker({
    repoRoot,
    branchName: worker.branch,
    agentType: 'codex',
    agentCommand: opts.agentCommand,
    resumeSessionId: bundle.hydraSession.agentSessionId,
    preservedWorkerInfo,
    preserveWorkerId: false,
    notifyCopilot: false,
    fetchMode: 'best-effort',
  });
  await postCreatePromise;
  return workerInfo;
}

function formatShareConfigForOutput(config = getHydraConfig().share || {}): Record<string, string | null> {
  return {
    bucket: config.bucket || null,
    prefix: config.prefix || 'shares',
    publicBaseUrl: config.publicBaseUrl || null,
  };
}

function updateShareConfig(opts: ShareConfigOpts): Record<string, string | null> {
  const nextConfig = updateHydraConfig(currentConfig => {
    if (opts.clear) {
      const clearedConfig = { ...currentConfig };
      delete clearedConfig.share;
      return clearedConfig;
    }

    const shareConfig = { ...(currentConfig.share || {}) };
    if (opts.bucket !== undefined) {
      shareConfig.bucket = normalizeGcsBucket(opts.bucket);
    }
    if (opts.prefix !== undefined) {
      shareConfig.prefix = stripSlashes(opts.prefix) || 'shares';
    }
    if (opts.publicBaseUrl !== undefined) {
      shareConfig.publicBaseUrl = opts.publicBaseUrl.replace(/\/+$/, '').trim();
    }
    if (opts.public === true) {
      if (!shareConfig.bucket) {
        throw new Error('Configure --bucket before enabling --public');
      }
      shareConfig.publicBaseUrl = buildDefaultPublicBaseUrl(shareConfig.bucket);
    } else if (opts.public === false) {
      delete shareConfig.publicBaseUrl;
    }

    return {
      ...currentConfig,
      share: shareConfig,
    };
  });
  return formatShareConfigForOutput(nextConfig.share || {});
}

function hasShareConfigMutation(opts: ShareConfigOpts): boolean {
  return opts.clear
    || opts.bucket !== undefined
    || opts.prefix !== undefined
    || opts.public !== undefined
    || opts.publicBaseUrl !== undefined;
}

export function registerShareCommands(program: Command): void {
  const share = program
    .command('share')
    .description('Share Hydra sessions through native agent resume data');

  share
    .command('config')
    .description('Show or update default share storage settings')
    .option('--bucket <bucket>', 'Default GCS bucket for share create/accept')
    .option('--prefix <prefix>', 'Default GCS object prefix')
    .option('--public', 'Use public HTTPS URLs for share-id accept')
    .option('--no-public', 'Use gcloud/gsutil for share-id accept')
    .option('--public-base-url <url>', 'Public base URL for share-id accept')
    .option('--clear', 'Clear default share storage settings')
    .action((opts: ShareConfigOpts) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const changed = hasShareConfigMutation(opts);
        const config = changed ? updateShareConfig(opts) : formatShareConfigForOutput();

        outputResult(
          { status: changed ? 'updated' : 'ok', share: config },
          globalOpts,
          () => {
            console.log('Share config:');
            console.log(`  Bucket:          ${config.bucket || 'none'}`);
            console.log(`  Prefix:          ${config.prefix || 'shares'}`);
            console.log(`  Public base URL: ${config.publicBaseUrl || 'none'}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  share
    .command('create <session>')
    .description('Create a native Codex share bundle locally or upload it to GCS')
    .option('--bucket <bucket>', 'GCS bucket for share bundles')
    .option('--prefix <prefix>', 'GCS object prefix', 'shares')
    .option('--out <path>', 'Write the share bundle to a local file instead of GCS')
    .option('--stop', 'Send /quit before exporting so Codex flushes native session data')
    .option('--yes', 'Acknowledge that the bundle is not encrypted')
    .action(async (sessionName: string, opts: CreateShareOpts) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        if (opts.out && opts.bucket) {
          throw new Error('Specify only one destination: --out <path> or --bucket <bucket>.');
        }
        const bucket = opts.out ? undefined : getConfiguredShareBucket(opts.bucket);
        if (!opts.out && !bucket) {
          throw new Error(
            'Specify a destination: --out <path> for local testing or --bucket <bucket> for GCS. ' +
            'You can also run `hydra share config --bucket <bucket>` once and omit --bucket.',
          );
        }
        warnUnencrypted(globalOpts, opts.yes);

        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const state = await sm.sync();
        const session = findShareableSession(state, sessionName);
        if (!session) {
          throw new Error(`Session "${sessionName}" not found`);
        }
        if (session.type === 'worker' && isDirectoryWorker(session.data)) {
          throw new Error('Task workers cannot be shared yet. Share currently supports copilots and code workers only.');
        }

        if (opts.stop) {
          await stopSessionForExport(backend, session);
        }

        const bundle = await createShareBundle(session);
        const localBundlePath = opts.out ? resolveOutputPath(opts.out) : await writeTempBundle(bundle);
        writeBundle(localBundlePath, bundle);

        let destination = localBundlePath;
        let publicUrl: string | null = null;
        if (bucket) {
          const prefix = getConfiguredSharePrefix(opts.prefix);
          destination = buildGcsBundleUrl({
            bucket,
            prefix,
            shareId: bundle.shareId,
          });
          await uploadBundle(localBundlePath, destination);

          const publicBaseUrl = getConfiguredPublicBaseUrl();
          if (publicBaseUrl) {
            publicUrl = buildPublicHttpBundleUrl({
              publicBaseUrl,
              prefix,
              shareId: bundle.shareId,
            });
          }
        }

        outputResult(
          {
            status: 'created',
            shareId: bundle.shareId,
            destination,
            session: session.data.sessionName,
            type: session.type,
            agent: 'codex',
            agentSessionId: session.data.sessionId,
            encryption: bundle.encryption,
            publicUrl,
          },
          globalOpts,
          () => {
            console.log(`Created share: ${bundle.shareId}`);
            console.log(`  Location:   ${destination}`);
            if (publicUrl) {
              console.log(`  Public URL: ${publicUrl}`);
            }
            console.log(`  Session:    ${session.data.sessionName}`);
            console.log(`  Type:       ${session.type}`);
            console.log(`  Agent:      codex`);
            console.log(`  Session ID: ${session.data.sessionId}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });

  share
    .command('accept <share-ref>')
    .description('Accept a local, GCS, or HTTPS native Codex share bundle and resume it locally')
    .requiredOption('--repo <path>', 'Path to the local copy of the shared repository')
    .option('--bucket <bucket>', 'GCS bucket when share-ref is a share ID')
    .option('--prefix <prefix>', 'GCS object prefix', 'shares')
    .option('--session <name>', 'Override the local Hydra session name')
    .option('--agent-command <command>', 'Override the Codex command used to resume the shared session')
    .option('--force', 'Overwrite an existing Codex session file if contents differ')
    .option('--allow-mismatch', 'Allow repo remote or commit mismatch')
    .action(async (shareRef: string, opts: AcceptShareOpts) => {
      const globalOpts = program.opts() as OutputOpts;
      try {
        const { bundlePath: localBundlePath, source } = await resolveBundleInput(shareRef, opts);
        const bundle = readBundle(localBundlePath);

        const resolvedRepoInput = resolveRepoInput(opts.repo);
        const repoRoot = await getRepoRootFromPath(expandPath(resolvedRepoInput.path));
        await validateRepoMatch(bundle.repo, repoRoot, opts.allowMismatch);
        const nativeImport = importCodexNativeSession(bundle.agents.codex, { force: opts.force });

        const backend = new TmuxBackendCore();
        const sm = new SessionManager(backend);
        const lifecycle = new WorkerLifecycleService({ backend, sessionManager: sm, eventSource: 'cli' });
        const result = bundle.hydraSession.type === 'copilot'
          ? await acceptCopilot(sm, backend, bundle, repoRoot, opts)
          : await acceptWorker(lifecycle, backend, bundle, repoRoot, opts);

        outputResult(
          {
            status: 'accepted',
            shareId: bundle.shareId,
            source,
            type: bundle.hydraSession.type,
            session: result.sessionName,
            agent: 'codex',
            agentSessionId: bundle.hydraSession.agentSessionId,
            workdir: result.workdir,
            nativeSessionFiles: nativeImport,
          },
          globalOpts,
          () => {
            console.log(`Accepted share: ${bundle.shareId}`);
            console.log(`  Source:     ${source}`);
            console.log(`  Session:    ${result.sessionName}`);
            console.log(`  Type:       ${bundle.hydraSession.type}`);
            console.log(`  Agent:      codex`);
            console.log(`  Workdir:    ${result.workdir}`);
            console.log(`  Session ID: ${bundle.hydraSession.agentSessionId}`);
          },
        );
      } catch (error) {
        outputError(error, globalOpts);
      }
    });
}
