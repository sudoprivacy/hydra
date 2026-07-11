import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getHydraHome } from './path';

export interface WorkerIdentityLike {
  workerId: number;
  lifecycleEpoch?: string | null;
  sessionName?: string | null;
  sessionAliases?: readonly string[] | null;
}

export interface WorkerIdentityMigrationBackup {
  version: 1;
  migration: 'worker-identity-v1';
  createdAt: string;
  backupDirectory: string;
  files: Array<{ source: string; backup: string }>;
}

const MAX_ID_LENGTH = 500;
const MIGRATION_NAME = 'worker-identity-v1';

export function compatibilityWorkerLifecycleEpoch(workerId: number): string {
  validateWorkerId(workerId);
  return `legacy-worker-${workerId}`;
}

export function createWorkerLifecycleEpoch(): string {
  return randomUUID();
}

export function getWorkerLifecycleEpoch(worker: WorkerIdentityLike): string {
  validateWorkerId(worker.workerId);
  const lifecycleEpoch = normalizeOptionalString(worker.lifecycleEpoch, MAX_ID_LENGTH);
  return lifecycleEpoch ?? compatibilityWorkerLifecycleEpoch(worker.workerId);
}

export function normalizeWorkerSessionAliases(worker: WorkerIdentityLike): string[] {
  const current = normalizeOptionalString(worker.sessionName, MAX_ID_LENGTH);
  const aliases = Array.isArray(worker.sessionAliases) ? worker.sessionAliases : [];
  const normalized = new Set<string>();
  for (const alias of aliases) {
    const value = normalizeOptionalString(alias, MAX_ID_LENGTH);
    if (value && value !== current) normalized.add(value);
  }
  return [...normalized];
}

export function workerMatchesSessionRoute(worker: WorkerIdentityLike, sessionName: string): boolean {
  const target = sessionName.trim();
  if (!target) return false;
  return worker.sessionName === target || normalizeWorkerSessionAliases(worker).includes(target);
}

export function ensureWorkerIdentityMigrationBackup(): WorkerIdentityMigrationBackup | undefined {
  const hydraHome = getHydraHome();
  const migrationDirectory = path.join(hydraHome, 'migrations');
  const markerPath = path.join(migrationDirectory, `${MIGRATION_NAME}.json`);
  const existing = readMigrationMarker(markerPath);
  if (existing) return existing;

  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const backupDirectory = path.join(hydraHome, 'backups', `${MIGRATION_NAME}-${stamp}`);
  const candidates = [
    'sessions.json',
    'archive.json',
    'worker-runtime-state.json',
    'worker-runtime-state-v2.json',
    'notifications.json',
    'notifications-v2.json',
    'completion-jobs.json',
  ].map(name => path.join(hydraHome, name));

  const files: WorkerIdentityMigrationBackup['files'] = [];
  fs.mkdirSync(backupDirectory, { recursive: true });
  for (const source of candidates) {
    if (!fs.existsSync(source)) continue;
    const backup = path.join(backupDirectory, path.basename(source));
    fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
    files.push({ source, backup });
  }

  const manifest: WorkerIdentityMigrationBackup = {
    version: 1,
    migration: MIGRATION_NAME,
    createdAt,
    backupDirectory,
    files,
  };
  fs.mkdirSync(migrationDirectory, { recursive: true });
  writeJsonAtomically(markerPath, manifest);
  return manifest;
}

function readMigrationMarker(markerPath: string): WorkerIdentityMigrationBackup | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<WorkerIdentityMigrationBackup>;
    if (value.version !== 1
      || value.migration !== MIGRATION_NAME
      || typeof value.createdAt !== 'string'
      || typeof value.backupDirectory !== 'string'
      || !Array.isArray(value.files)) {
      throw new Error(`Worker identity migration marker at ${markerPath} has invalid shape`);
    }
    return value as WorkerIdentityMigrationBackup;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tmpPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function validateWorkerId(workerId: number): void {
  if (!Number.isSafeInteger(workerId) || workerId <= 0) {
    throw new Error('Worker identity workerId must be a positive safe integer');
  }
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
