import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveAgentSessionFile } from '../core/path';
import type { CodexNativeSessionPayload, NativeSessionFile } from './types';

export interface ImportCodexSessionOptions {
  force?: boolean;
}

export interface ImportCodexSessionResult {
  written: string[];
  skipped: string[];
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toHomeRelativePath(filePath: string): string {
  const home = path.resolve(os.homedir());
  const absoluteFilePath = path.resolve(filePath);
  const relative = path.relative(home, absoluteFilePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Codex session file is outside the current home directory: ${filePath}`);
  }
  return relative;
}

function resolveHomeRelativePath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid native session path in bundle: ${relativePath}`);
  }

  const home = path.resolve(os.homedir());
  const absolutePath = path.resolve(home, relativePath);
  const normalizedRelative = path.relative(home, absolutePath);
  if (!normalizedRelative || normalizedRelative.startsWith('..') || path.isAbsolute(normalizedRelative)) {
    throw new Error(`Native session path escapes the home directory: ${relativePath}`);
  }
  return absolutePath;
}

function readNativeSessionFile(filePath: string): NativeSessionFile {
  const contents = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    homeRelativePath: toHomeRelativePath(filePath),
    mode: stat.mode & 0o777,
    size: contents.length,
    sha256: sha256(contents),
    contentBase64: contents.toString('base64'),
  };
}

export function exportCodexNativeSession(
  workdir: string,
  sessionId: string,
): CodexNativeSessionPayload {
  const sessionFile = resolveAgentSessionFile('codex', workdir, sessionId);
  if (!sessionFile) {
    throw new Error(`Codex session file not found for session ID "${sessionId}"`);
  }

  return {
    adapter: 'codex',
    adapterVersion: 1,
    sessionId,
    files: [readNativeSessionFile(sessionFile)],
  };
}

export function importCodexNativeSession(
  payload: CodexNativeSessionPayload,
  options: ImportCodexSessionOptions = {},
): ImportCodexSessionResult {
  if (payload.adapter !== 'codex') {
    throw new Error(`Unsupported native session adapter: ${payload.adapter}`);
  }
  if (payload.adapterVersion !== 1) {
    throw new Error(`Unsupported Codex adapter version: ${payload.adapterVersion}`);
  }
  if (!payload.sessionId) {
    throw new Error('Codex native session payload is missing sessionId');
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of payload.files) {
    const contents = Buffer.from(file.contentBase64, 'base64');
    const actualHash = sha256(contents);
    if (actualHash !== file.sha256) {
      throw new Error(`Hash mismatch for native session file: ${file.homeRelativePath}`);
    }
    if (contents.length !== file.size) {
      throw new Error(`Size mismatch for native session file: ${file.homeRelativePath}`);
    }

    const targetPath = resolveHomeRelativePath(file.homeRelativePath);
    if (fs.existsSync(targetPath)) {
      const existingHash = sha256(fs.readFileSync(targetPath));
      if (existingHash === file.sha256) {
        skipped.push(targetPath);
        continue;
      }
      if (!options.force) {
        throw new Error(
          `Codex session file already exists with different contents: ${targetPath}. Use --force to overwrite it.`,
        );
      }
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, { mode: file.mode || 0o600 });
    try {
      fs.chmodSync(targetPath, file.mode || 0o600);
    } catch {
      // Best-effort: some filesystems ignore chmod.
    }
    written.push(targetPath);
  }

  return { written, skipped };
}
