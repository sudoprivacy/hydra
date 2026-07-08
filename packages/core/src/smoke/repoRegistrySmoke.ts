import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addRepo,
  fetchRepo,
  isRegisteredRepo,
  isRegistryManagedPath,
  listRegisteredRepos,
  looksLikePathInput,
  parseRepoIdentifier,
  removeRepo,
  resolveRepoIdentifier,
  resolveRepoInput,
} from '../core/repoRegistry';

interface SubTest {
  name: string;
  run: () => Promise<void> | void;
}

const tests: SubTest[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

function setupHydraHome(): { tempHome: string; cleanup: () => void; restore: Record<string, string | undefined> } {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-repo-registry-'));
  const restore: Record<string, string | undefined> = {
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
    HOME: process.env.HOME,
  };
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_CONFIG_PATH = path.join(tempHome, '.hydra', 'config.json');
  process.env.HOME = tempHome;
  return {
    tempHome,
    restore,
    cleanup: () => {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** Build a tiny bare-cloneable git repo on disk and return its filesystem URL. */
function makeFakeGitOrigin(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-fake-origin-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git -c user.email=hydra@test.local -c user.name=hydra commit -q --allow-empty -m init', { cwd: dir });
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

// ── parseRepoIdentifier: all 4 input formats normalize correctly ──

test('parseRepoIdentifier: short-form <owner>/<name>', () => {
  const p = parseRepoIdentifier('joezhoujinjing/hydra');
  assert.equal(p.owner, 'joezhoujinjing');
  assert.equal(p.name, 'hydra');
  assert.equal(p.canonical, 'joezhoujinjing/hydra');
  assert.equal(p.cloneUrl, 'https://github.com/joezhoujinjing/hydra.git');
});

test('parseRepoIdentifier: https URL without .git', () => {
  const p = parseRepoIdentifier('https://github.com/joezhoujinjing/hydra');
  assert.equal(p.canonical, 'joezhoujinjing/hydra');
});

test('parseRepoIdentifier: https URL with .git', () => {
  const p = parseRepoIdentifier('https://github.com/joezhoujinjing/hydra.git');
  assert.equal(p.canonical, 'joezhoujinjing/hydra');
});

test('parseRepoIdentifier: SSH URL', () => {
  const p = parseRepoIdentifier('git@github.com:joezhoujinjing/hydra.git');
  assert.equal(p.canonical, 'joezhoujinjing/hydra');
});

test('parseRepoIdentifier: rejects empty input', () => {
  assert.throws(() => parseRepoIdentifier(''), /required/i);
});

test('parseRepoIdentifier: rejects non-GitHub URL', () => {
  assert.throws(() => parseRepoIdentifier('https://gitlab.com/joezhoujinjing/hydra'), /Could not parse/i);
});

test('parseRepoIdentifier: rejects malformed input', () => {
  assert.throws(() => parseRepoIdentifier('not a repo'), /Could not parse/i);
  assert.throws(() => parseRepoIdentifier('foo/bar/baz'), /Could not parse/i);
});

// ── Path traversal: `.`, `..`, `.git`, pure-dot strings must be rejected ──
// Otherwise getRegistryRepoPath("fake", "..") would resolve to ~/.hydra/repos
// itself, and add/remove would operate on the registry root.

test('parseRepoIdentifier: rejects "foo/.." (path traversal)', () => {
  assert.throws(() => parseRepoIdentifier('foo/..'), /unsafe path component/i);
});

test('parseRepoIdentifier: rejects "../foo" (path traversal)', () => {
  // This first fails the SHORT_FORM_RE because a leading `..` is not an owner;
  // either parse failure OR the unsafe-component guard is acceptable.
  assert.throws(() => parseRepoIdentifier('../foo'), /unsafe path component|Could not parse/i);
});

test('parseRepoIdentifier: rejects "./foo"', () => {
  assert.throws(() => parseRepoIdentifier('./foo'), /unsafe path component|Could not parse/i);
});

test('parseRepoIdentifier: rejects "foo/.git"', () => {
  // ".git" → strips trailing .git → empty name → caught earlier.
  // We still want to make sure this never silently maps to <owner>/.git.
  assert.throws(() => parseRepoIdentifier('foo/.git'), /non-empty|unsafe path component/i);
});

test('parseRepoIdentifier: rejects "foo/."', () => {
  assert.throws(() => parseRepoIdentifier('foo/.'), /unsafe path component/i);
});

test('parseRepoIdentifier: rejects "./."', () => {
  assert.throws(() => parseRepoIdentifier('./.'), /unsafe path component|Could not parse/i);
});

test('parseRepoIdentifier: rejects pure-dot owner "..../foo"', () => {
  assert.throws(() => parseRepoIdentifier('..../foo'), /unsafe path component/i);
});

// ── resolveRepoIdentifier ──

test('resolveRepoIdentifier: absolute path passes through unchanged', () => {
  const env = setupHydraHome();
  try {
    const abs = path.resolve('/tmp/fake-repo');
    assert.equal(resolveRepoIdentifier(abs), abs);
  } finally {
    env.cleanup();
  }
});

test('resolveRepoIdentifier: short-form throws when not registered', () => {
  const env = setupHydraHome();
  try {
    assert.throws(
      () => resolveRepoIdentifier('joezhoujinjing/hydra'),
      /not registered.*hydra repo add/,
    );
  } finally {
    env.cleanup();
  }
});

test('resolveRepoIdentifier: URL throws with helpful message', () => {
  const env = setupHydraHome();
  try {
    assert.throws(
      () => resolveRepoIdentifier('https://github.com/joezhoujinjing/hydra'),
      /hydra repo add/,
    );
  } finally {
    env.cleanup();
  }
});

// ── looksLikePathInput / resolveRepoInput: the BC dispatch rule ──

test('looksLikePathInput: classifies path-like inputs', () => {
  // Path-like
  assert.equal(looksLikePathInput('.'), true);
  assert.equal(looksLikePathInput('..'), true);
  assert.equal(looksLikePathInput('./foo'), true);
  assert.equal(looksLikePathInput('../foo'), true);
  assert.equal(looksLikePathInput('.foo'), true);
  assert.equal(looksLikePathInput('/abs/path'), true);
  assert.equal(looksLikePathInput('~/foo'), true);
  assert.equal(looksLikePathInput('C:\\foo'), true);
  assert.equal(looksLikePathInput('D:/bar'), true);
  // Identifier-like
  assert.equal(looksLikePathInput('foo/bar'), false);
  assert.equal(looksLikePathInput('joezhoujinjing/hydra'), false);
  assert.equal(looksLikePathInput('https://github.com/foo/bar'), false);
  assert.equal(looksLikePathInput('git@github.com:foo/bar.git'), false);
  // Edge cases
  assert.equal(looksLikePathInput(''), false);
  assert.equal(looksLikePathInput('   '), false);
});

test('resolveRepoInput: "." resolves to cwd (BC: --repo . from a git repo)', () => {
  const env = setupHydraHome();
  try {
    const result = resolveRepoInput('.');
    assert.equal(result.path, path.resolve('.'));
    assert.equal(result.isManaged, false);
  } finally {
    env.cleanup();
  }
});

test('resolveRepoInput: "./foo" resolves relative to cwd', () => {
  const env = setupHydraHome();
  try {
    const result = resolveRepoInput('./some-subdir');
    assert.equal(result.path, path.resolve('./some-subdir'));
    assert.equal(result.isManaged, false);
  } finally {
    env.cleanup();
  }
});

test('resolveRepoInput: abs path classified as path, isManaged=false when outside repos root', () => {
  const env = setupHydraHome();
  try {
    const result = resolveRepoInput('/tmp/some-repo');
    assert.equal(result.path, '/tmp/some-repo');
    assert.equal(result.isManaged, false);
  } finally {
    env.cleanup();
  }
});

test('resolveRepoInput: registered short-form returns managed path with isManaged=true', () => {
  const env = setupHydraHome();
  const origin = makeFakeGitOrigin();
  try {
    const reposRoot = path.join(process.env.HYDRA_HOME!, 'repos');
    const repoPath = path.join(reposRoot, 'fake', 'local');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execSync(`git clone -q "${origin.dir}" "${repoPath}"`);

    const result = resolveRepoInput('fake/local');
    assert.equal(result.path, repoPath);
    assert.equal(result.isManaged, true);
  } finally {
    origin.cleanup();
    env.cleanup();
  }
});

test('resolveRepoInput: short-form path-traversal attempts are rejected', () => {
  const env = setupHydraHome();
  try {
    assert.throws(() => resolveRepoInput('foo/..'), /unsafe path component/i);
    assert.throws(() => resolveRepoInput('foo/.git'), /non-empty|unsafe path component/i);
  } finally {
    env.cleanup();
  }
});

// ── addRepo / listRegisteredRepos / fetchRepo / removeRepo ──

test('addRepo: clones via real CLI path against local origin (no network)', async () => {
  const env = setupHydraHome();
  const origin = makeFakeGitOrigin();
  try {
    // Drive addRepo's real clone branch using the cloneUrl override — exercises
    // exec('git clone ...') end-to-end without ever touching github.com.
    const result = await addRepo('fake/local', { cloneUrl: origin.dir });
    assert.equal(result.alreadyExisted, false);
    assert.equal(result.parsed.canonical, 'fake/local');
    assert.ok(fs.existsSync(path.join(result.path, '.git')));
    assert.ok(isRegisteredRepo('fake', 'local'));
    assert.equal(resolveRepoIdentifier('fake/local'), result.path);

    const repos = listRegisteredRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].canonical, 'fake/local');

    // Idempotency: second addRepo no-ops because the directory already exists,
    // regardless of whether the override is passed.
    const second = await addRepo('fake/local', { cloneUrl: origin.dir });
    assert.equal(second.alreadyExisted, true);
    assert.equal(second.path, result.path);

    // Fetch against the local origin.
    await fetchRepo('fake', 'local');
    const refreshed = listRegisteredRepos();
    assert.equal(refreshed[0].lastFetchedAt !== null, true, 'lastFetchedAt should be set after fetch');

    await removeRepo('fake/local', { force: true });
    assert.equal(isRegisteredRepo('fake', 'local'), false);
  } finally {
    origin.cleanup();
    env.cleanup();
  }
});

test('addRepo: cleans up partial directory when clone fails', async () => {
  const env = setupHydraHome();
  const origin = makeFakeGitOrigin();
  try {
    const reposRoot = path.join(process.env.HYDRA_HOME!, 'repos');
    const repoPath = path.join(reposRoot, 'fake', 'partial');

    // First add against a bogus origin → clone fails. Without the cleanup fix,
    // git would leave a partial directory behind (even on EARLY failure of
    // "destination path ... already exists" if it pre-created the parent dir).
    await assert.rejects(
      addRepo('fake/partial', { cloneUrl: '/this/path/does/not/exist' }),
      /Command failed|fatal|repository/,
    );
    // The repoPath itself must NOT exist after a failed clone, so the next
    // addRepo doesn't trip "destination path ... already exists and is not
    // empty".
    assert.equal(
      fs.existsSync(repoPath),
      false,
      'partial clone directory must be cleaned up on failure',
    );

    // Second add with a valid override succeeds — proves the cleanup unblocked it.
    const result = await addRepo('fake/partial', { cloneUrl: origin.dir });
    assert.equal(result.alreadyExisted, false);
    assert.ok(fs.existsSync(path.join(result.path, '.git')));
  } finally {
    origin.cleanup();
    env.cleanup();
  }
});

test('removeRepo: refuses when worktrees exist (no --force)', async () => {
  const env = setupHydraHome();
  const origin = makeFakeGitOrigin();
  try {
    const fakeOwner = 'fake';
    const fakeName = 'with-worktree';
    const reposRoot = path.join(process.env.HYDRA_HOME!, 'repos');
    const repoPath = path.join(reposRoot, fakeOwner, fakeName);
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    execSync(`git clone -q "${origin.dir}" "${repoPath}"`);

    // Create a worktree off the managed clone
    const worktreePath = path.join(env.tempHome, 'extra-worktree');
    execSync(`git -C "${repoPath}" worktree add -b feat/test "${worktreePath}"`);

    await assert.rejects(
      removeRepo(`${fakeOwner}/${fakeName}`),
      /still has active worktrees/,
    );

    // --force succeeds even with worktrees.
    await removeRepo(`${fakeOwner}/${fakeName}`, { force: true });
    assert.equal(isRegisteredRepo(fakeOwner, fakeName), false);
  } finally {
    origin.cleanup();
    env.cleanup();
  }
});

test('isRegistryManagedPath: classifies paths under ~/.hydra/repos/', () => {
  const env = setupHydraHome();
  try {
    const reposRoot = path.join(process.env.HYDRA_HOME!, 'repos');
    assert.equal(isRegistryManagedPath(path.join(reposRoot, 'fake', 'local')), true);
    assert.equal(isRegistryManagedPath('/tmp/some-other-path'), false);
  } finally {
    env.cleanup();
  }
});

// ── Optional end-to-end smoke against the real GitHub: SMOKE_REPO_REGISTRY=1 ──

if (process.env.SMOKE_REPO_REGISTRY) {
  test('SMOKE: addRepo against real GitHub', async () => {
    const env = setupHydraHome();
    try {
      const result = await addRepo('joezhoujinjing/ladon');
      assert.equal(result.alreadyExisted, false);
      assert.ok(fs.existsSync(path.join(result.path, '.git')));
      const second = await addRepo('joezhoujinjing/ladon');
      assert.equal(second.alreadyExisted, true);
      await removeRepo('joezhoujinjing/ladon', { force: true });
    } finally {
      env.cleanup();
    }
  });
}

// ── Runner ──

async function main(): Promise<void> {
  const failures: string[] = [];
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (error) {
      failures.push(`${t.name}: ${(error as Error).message}`);
      console.error(`  FAIL  ${t.name}: ${(error as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
