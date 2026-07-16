import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
const version = packageJson.version;
const productName = packageJson.build.productName;
const arch = 'arm64';
const distDir = path.join(packageDir, 'dist');
const appOutDir = path.join(distDir, `mac-${arch}`);
const appPath = path.join(appOutDir, `${productName}.app`);
const submissionArchive = path.join(distDir, `${productName}-notarization.zip`);
const submissionStatePath = path.join(distDir, 'notary-submission.json');
const dmgPath = path.join(distDir, `${productName}-${version}-${arch}.dmg`);
const zipPath = path.join(distDir, `${productName}-${version}-${arch}-mac.zip`);
const zipBlockmapPath = `${zipPath}.blockmap`;
const updateMetadataPath = path.join(distDir, 'latest-mac.yml');
const builderPath = path.join(repoRoot, 'node_modules', '.bin', 'electron-builder');
const resume = process.argv.includes('--resume');
const waitTimeout = process.env.HYDRA_NOTARY_WAIT_TIMEOUT ?? '2h';

function releaseEnvironment() {
  const env = { ...process.env };
  for (const name of [
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_ID',
    'APPLE_KEYCHAIN',
    'APPLE_KEYCHAIN_PROFILE',
    'APPLE_TEAM_ID',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]) {
    delete env[name];
  }
  return env;
}

function notaryAuthenticationArgs() {
  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  const apiCredentialCount = [apiKey, apiKeyId, apiIssuer].filter(Boolean).length;

  if (apiCredentialCount > 0) {
    if (apiCredentialCount !== 3) {
      throw new Error('APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER must be provided together.');
    }
    return ['--key', apiKey, '--key-id', apiKeyId, '--issuer', apiIssuer];
  }

  const appleId = process.env.APPLE_ID;
  const appSpecificPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const appleIdCredentialCount = [appleId, appSpecificPassword, teamId].filter(Boolean).length;
  if (appleIdCredentialCount > 0) {
    if (appleIdCredentialCount !== 3) {
      throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be provided together.');
    }
    return ['--apple-id', appleId, '--password', appSpecificPassword, '--team-id', teamId];
  }

  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE ?? (process.env.CI ? undefined : 'hydra-notary');
  if (!keychainProfile) {
    throw new Error('Set Apple API key variables in CI or APPLE_KEYCHAIN_PROFILE for a local release.');
  }

  const args = ['--keychain-profile', keychainProfile];
  if (process.env.APPLE_KEYCHAIN) {
    args.push('--keychain', process.env.APPLE_KEYCHAIN);
  }
  return args;
}

async function run(command, args, options = {}) {
  const { allowFailure = false, capture = false, cwd = packageDir, env = process.env } = options;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  let stdout = '';
  let stderr = '';
  if (capture) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
  }

  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });

  if (result.code !== 0 && !allowFailure) {
    if (capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} exited with code ${result.code}`);
  }
  return result;
}

function parseJsonOutput(output, commandName) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end < start) {
    throw new Error(`${commandName} did not return JSON output.`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

async function runNotaryJson(command, args) {
  const result = await run('xcrun', ['notarytool', command, ...args], { capture: true });
  return parseJsonOutput(result.stdout, `notarytool ${command}`);
}

async function writeSubmissionState(submissionId, status) {
  await writeFile(
    submissionStatePath,
    `${JSON.stringify(
      {
        appPath: path.relative(packageDir, appPath),
        status,
        submissionId,
        updatedAt: new Date().toISOString(),
        version,
      },
      null,
      2,
    )}\n`,
  );
}

async function submitForNotarization(authArgs) {
  console.log('hydra-desktop release: creating notarization archive');
  await rm(submissionArchive, { force: true });
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, submissionArchive]);

  console.log('hydra-desktop release: submitting to Apple notarization');
  const submission = await runNotaryJson('submit', [
    submissionArchive,
    ...authArgs,
    '--output-format',
    'json',
    '--no-wait',
  ]);
  if (!submission.id) {
    throw new Error('Apple notarization submission did not return an ID.');
  }
  await writeSubmissionState(submission.id, submission.status ?? 'In Progress');
  console.log(`hydra-desktop release: submission ${submission.id}`);
  return submission.id;
}

async function readSubmissionId() {
  const state = JSON.parse(await readFile(submissionStatePath, 'utf8'));
  if (!state.submissionId) {
    throw new Error(`${submissionStatePath} does not contain a submissionId.`);
  }
  if (state.version !== version) {
    throw new Error(`Saved notarization is for version ${state.version}, current version is ${version}.`);
  }
  return state.submissionId;
}

async function waitForNotarization(submissionId, authArgs) {
  let info = await runNotaryJson('info', [submissionId, ...authArgs, '--output-format', 'json']);
  if (info.status === 'In Progress') {
    console.log(`hydra-desktop release: waiting up to ${waitTimeout} for Apple notarization`);
    await run(
      'xcrun',
      ['notarytool', 'wait', submissionId, ...authArgs, '--timeout', waitTimeout, '--no-progress'],
      { allowFailure: true },
    );
    info = await runNotaryJson('info', [submissionId, ...authArgs, '--output-format', 'json']);
  }

  await writeSubmissionState(submissionId, info.status);
  if (info.status === 'In Progress') {
    throw new Error(
      `Apple notarization is still in progress. Resume with: npm run dist:mac:release:resume -w @hydra/desktop`,
    );
  }
  if (info.status !== 'Accepted') {
    await run('xcrun', ['notarytool', 'log', submissionId, ...authArgs], { allowFailure: true });
    throw new Error(`Apple notarization finished with status: ${info.status}`);
  }
  console.log(`hydra-desktop release: Apple accepted submission ${submissionId}`);
}

async function validateApp(candidatePath) {
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', candidatePath]);
  await run('xcrun', ['stapler', 'validate', candidatePath]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', candidatePath]);
  await validateBundledCli(candidatePath);
}

async function validateBundledCli(candidatePath) {
  const appRoot = path.join(candidatePath, 'Contents', 'Resources', 'app');
  const cliPackagePath = path.join(appRoot, 'node_modules', '@hydra', 'cli', 'package.json');
  const cliEntryPoint = path.join(appRoot, 'node_modules', '@hydra', 'cli', 'out', 'cli', 'index.js');
  const cliPackage = JSON.parse(await readFile(cliPackagePath, 'utf8'));
  if (cliPackage.version !== version) {
    throw new Error(`Packaged Hydra CLI version ${cliPackage.version} does not match Desktop ${version}.`);
  }
  if ((await stat(cliEntryPoint)).size === 0) {
    throw new Error(`Packaged Hydra CLI entry point is empty: ${cliEntryPoint}`);
  }

  const result = await run(process.execPath, [cliEntryPoint, '--version'], {
    capture: true,
    cwd: appRoot,
  });
  if (result.stdout.trim() !== version) {
    throw new Error(`Packaged Hydra CLI reported ${result.stdout.trim() || 'no version'}, expected ${version}.`);
  }
  console.log(`hydra-desktop release: bundled CLI verified at ${version}`);
}

async function stapleApp() {
  const validation = await run('xcrun', ['stapler', 'validate', appPath], { allowFailure: true, capture: true });
  if (validation.code !== 0) {
    console.log('hydra-desktop release: stapling Apple ticket');
    await run('xcrun', ['stapler', 'staple', appPath]);
  }
  await validateApp(appPath);
}

async function validateDmg() {
  await run('hdiutil', ['verify', dmgPath]);
  const mountDir = await mkdtemp(path.join(tmpdir(), 'hydra-dmg-verify-'));
  try {
    await run('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountDir], { capture: true });
    await validateApp(path.join(mountDir, `${productName}.app`));
  } finally {
    await run('hdiutil', ['detach', mountDir], { allowFailure: true, capture: true });
    await rm(mountDir, { force: true, recursive: true });
  }
}

async function validateZip() {
  const extractDir = await mkdtemp(path.join(tmpdir(), 'hydra-zip-verify-'));
  try {
    await run('ditto', ['-x', '-k', zipPath, extractDir]);
    await validateApp(path.join(extractDir, `${productName}.app`));
  } finally {
    await rm(extractDir, { force: true, recursive: true });
  }
}

async function validateUpdateMetadata() {
  const [metadata, zipInfo, blockmapInfo] = await Promise.all([
    readFile(updateMetadataPath, 'utf8'),
    stat(zipPath),
    stat(zipBlockmapPath),
  ]);
  const zipName = path.basename(zipPath);
  const zipSha512 = await hashFile(zipPath, 'sha512', 'base64');
  for (const required of [
    `version: ${version}`,
    `url: ${zipName}`,
    `path: ${zipName}`,
    `sha512: ${zipSha512}`,
  ]) {
    if (!metadata.includes(required)) {
      throw new Error(`${path.basename(updateMetadataPath)} is missing ${required}`);
    }
  }
  if (zipInfo.size === 0 || blockmapInfo.size === 0) {
    throw new Error('Update ZIP and blockmap must both be non-empty.');
  }
  console.log(`hydra-desktop release: updater metadata verified for ${zipName}`);
}

async function hashFile(filePath, algorithm, encoding) {
  return await new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest(encoding)));
  });
}

async function sha256(filePath) {
  return await hashFile(filePath, 'sha256', 'hex');
}

async function buildDistributables() {
  console.log('hydra-desktop release: building DMG from notarized app');
  await rm(dmgPath, { force: true });
  await rm(`${dmgPath}.blockmap`, { force: true });
  await run(
    builderPath,
    ['--mac', 'dmg', '--prepackaged', appOutDir, '--publish', 'never'],
    { env: releaseEnvironment() },
  );

  console.log('hydra-desktop release: building ZIP with Hydra.app at archive root');
  await rm(zipPath, { force: true });
  await rm(zipBlockmapPath, { force: true });
  await rm(updateMetadataPath, { force: true });
  await run(
    builderPath,
    ['--mac', 'zip', '--prepackaged', appPath, '--arm64', '--publish', 'never'],
    { env: releaseEnvironment() },
  );

  await validateDmg();
  await validateZip();
  await validateUpdateMetadata();
  console.log(`hydra-desktop release: DMG sha256 ${(await sha256(dmgPath))}`);
  console.log(`hydra-desktop release: ZIP sha256 ${(await sha256(zipPath))}`);
  await rm(submissionArchive, { force: true });
}

const authArgs = notaryAuthenticationArgs();
let submissionId;

if (resume) {
  submissionId = await readSubmissionId();
  console.log(`hydra-desktop release: resuming submission ${submissionId}`);
} else {
  console.log('hydra-desktop release: cleaning previous artifacts');
  await rm(distDir, { force: true, recursive: true });
  await mkdir(distDir, { recursive: true });
  await run('npm', ['run', 'build']);
  await run(builderPath, ['--mac', '--dir', '--arm64'], { env: releaseEnvironment() });
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  submissionId = await submitForNotarization(authArgs);
}

await waitForNotarization(submissionId, authArgs);
await stapleApp();
await buildDistributables();
console.log('hydra-desktop release: complete');
