import * as fs from 'fs';
import * as path from 'path';

export interface LogRotationOptions {
  maxFileSizeBytes: number;
  maxFiles: number;
}

export const DEFAULT_LOG_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 5;

export function normalizeRotationOptions(options?: Partial<LogRotationOptions>): LogRotationOptions {
  const maxFileSizeBytes = Number.isFinite(options?.maxFileSizeBytes)
    ? Math.max(1024, Math.floor(options!.maxFileSizeBytes!))
    : DEFAULT_LOG_MAX_FILE_SIZE_BYTES;
  const maxFiles = Number.isFinite(options?.maxFiles)
    ? Math.max(1, Math.floor(options!.maxFiles!))
    : DEFAULT_LOG_MAX_FILES;
  return { maxFileSizeBytes, maxFiles };
}

export async function appendRotatingLog(
  filePath: string,
  content: string,
  options?: Partial<LogRotationOptions>,
): Promise<void> {
  const normalized = normalizeRotationOptions(options);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  if (await shouldRotate(filePath, Buffer.byteLength(content), normalized.maxFileSizeBytes)) {
    await rotateLogFiles(filePath, normalized.maxFiles);
  }
  await fs.promises.appendFile(filePath, content, 'utf-8');
}

export function appendRotatingLogSync(
  filePath: string,
  content: string,
  options?: Partial<LogRotationOptions>,
): void {
  const normalized = normalizeRotationOptions(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (shouldRotateSync(filePath, Buffer.byteLength(content), normalized.maxFileSizeBytes)) {
    rotateLogFilesSync(filePath, normalized.maxFiles);
  }
  fs.appendFileSync(filePath, content, 'utf-8');
}

export async function ensureLogDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export function ensureLogDirectorySync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function shouldRotate(filePath: string, pendingBytes: number, maxFileSizeBytes: number): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size + pendingBytes > maxFileSizeBytes;
  } catch {
    return false;
  }
}

function shouldRotateSync(filePath: string, pendingBytes: number, maxFileSizeBytes: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.size + pendingBytes > maxFileSizeBytes;
  } catch {
    return false;
  }
}

async function rotateLogFiles(filePath: string, maxFiles: number): Promise<void> {
  if (maxFiles <= 1) {
    await removeIfExists(filePath);
    return;
  }

  await removeIfExists(rotatedPath(filePath, maxFiles - 1));
  for (let index = maxFiles - 2; index >= 1; index--) {
    await renameIfExists(rotatedPath(filePath, index), rotatedPath(filePath, index + 1));
  }
  await renameIfExists(filePath, rotatedPath(filePath, 1));
}

function rotateLogFilesSync(filePath: string, maxFiles: number): void {
  if (maxFiles <= 1) {
    removeIfExistsSync(filePath);
    return;
  }

  removeIfExistsSync(rotatedPath(filePath, maxFiles - 1));
  for (let index = maxFiles - 2; index >= 1; index--) {
    renameIfExistsSync(rotatedPath(filePath, index), rotatedPath(filePath, index + 1));
  }
  renameIfExistsSync(filePath, rotatedPath(filePath, 1));
}

function rotatedPath(filePath: string, index: number): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}.${index}${ext}`;
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // Best effort. Logging must not crash Hydra.
  }
}

function removeIfExistsSync(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort. Logging must not crash Hydra.
  }
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch {
    // Missing older rotations are normal.
  }
}

function renameIfExistsSync(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    // Missing older rotations are normal.
  }
}
