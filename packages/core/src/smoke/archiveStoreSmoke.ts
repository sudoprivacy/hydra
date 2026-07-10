import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArchiveStore } from '../core/archiveStore';

interface TestEntry {
  id: string;
  payload: {
    value: number;
  };
}

function isTestEntry(value: unknown): value is TestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<TestEntry>;
  return typeof entry.id === 'string'
    && !!entry.payload
    && typeof entry.payload === 'object'
    && typeof entry.payload.value === 'number';
}

function createEntry(id: string, value = 1): TestEntry {
  return { id, payload: { value } };
}

function withTempStore<T>(fn: (root: string, filePath: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-archive-store-'));
  try {
    return fn(root, path.join(root, 'archive.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testConcurrentUpdates(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-archive-concurrent-'));
  const filePath = path.join(root, 'archive.json');
  const barrierDir = path.join(root, 'barrier');
  const ids = ['writer-a', 'writer-b'];
  fs.mkdirSync(barrierDir, { recursive: true });
  fs.writeFileSync(filePath, '{"entries":[]}\n', 'utf-8');

  const children = ids.map(id => spawn(
    process.execPath,
    [__filename, '--writer-child', filePath, barrierDir, id],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ));

  try {
    await waitFor(
      () => ids.every(id => fs.existsSync(path.join(barrierDir, `ready-${id}`))),
      'archive writer readiness',
    );
    fs.writeFileSync(path.join(barrierDir, 'go'), 'go', 'utf-8');
    await Promise.all(children.map(waitForChild));

    const entries = new ArchiveStore<TestEntry>(filePath, isTestEntry).list();
    assert.deepEqual(entries.map(entry => entry.id).sort(), ids);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
    assert.deepEqual(findTempFiles(root, filePath), []);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCorruptJsonFailsClosed(): void {
  withTempStore((_root, filePath) => {
    const original = '{"entries":[';
    fs.writeFileSync(filePath, original, 'utf-8');
    const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);

    assert.throws(() => store.append(createEntry('new')), /is not valid JSON/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), original);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });
}

function testInvalidShapeFailsClosed(): void {
  withTempStore((_root, filePath) => {
    const original = '{"entries":{}}\n';
    fs.writeFileSync(filePath, original, 'utf-8');
    const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);

    assert.throws(() => store.append(createEntry('new')), /has invalid shape/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), original);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });
}

function testSnapshotsAreIsolated(): void {
  withTempStore((root, filePath) => {
    const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);
    const original = createEntry('isolated', 1);
    store.append(original);
    original.payload.value = 2;

    const first = store.list();
    assert.equal(first[0]?.payload.value, 1);
    first[0].payload.value = 3;
    first.push(createEntry('injected'));

    assert.deepEqual(store.list(), [createEntry('isolated', 1)]);
    assert.deepEqual(findTempFiles(root, filePath), []);
  });
}

function testValidatorRejectsBadEntry(): void {
  withTempStore((_root, filePath) => {
    const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);
    store.append(createEntry('valid'));
    const before = fs.readFileSync(filePath, 'utf-8');

    assert.throws(
      () => store.append({ id: 'invalid' } as TestEntry),
      /has an invalid entry at index 1/,
    );
    assert.equal(fs.readFileSync(filePath, 'utf-8'), before);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });
}

function testStaleLockRecovery(): void {
  withTempStore((_root, filePath) => {
    const lockDir = `${filePath}.lock`;
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'abandoned-owner'), '123', 'utf-8');
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, staleAt, staleAt);

    const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);
    store.append(createEntry('recovered'));

    assert.deepEqual(store.list(), [createEntry('recovered')]);
    assert.equal(fs.existsSync(lockDir), false);
  });
}

function runWriterChild(filePath: string, barrierDir: string, id: string): void {
  const store = new ArchiveStore<TestEntry>(filePath, isTestEntry);
  fs.writeFileSync(path.join(barrierDir, `ready-${id}`), 'ready', 'utf-8');
  while (!fs.existsSync(path.join(barrierDir, 'go'))) {
    sleepSync(10);
  }
  store.update(state => {
    state.entries.push(createEntry(id));
    sleepSync(100);
  });
}

function findTempFiles(root: string, filePath: string): string[] {
  const prefix = `${path.basename(filePath)}.`;
  return fs.readdirSync(root).filter(name => name.startsWith(prefix) && name.endsWith('.tmp'));
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`archive writer exited ${String(code)}: ${stderr.trim()}`));
      }
    });
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

async function main(): Promise<void> {
  await testConcurrentUpdates();
  testCorruptJsonFailsClosed();
  testInvalidShapeFailsClosed();
  testSnapshotsAreIsolated();
  testValidatorRejectsBadEntry();
  testStaleLockRecovery();
  console.log('archiveStoreSmoke: ok');
}

const childIndex = process.argv.indexOf('--writer-child');
if (childIndex >= 0) {
  const filePath = process.argv[childIndex + 1];
  const barrierDir = process.argv[childIndex + 2];
  const id = process.argv[childIndex + 3];
  if (!filePath || !barrierDir || !id) {
    throw new Error('archive writer child requires file path, barrier directory, and id');
  }
  runWriterChild(filePath, barrierDir, id);
} else {
  void main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
