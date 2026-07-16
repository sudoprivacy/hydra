/**
 * Deterministic cross-process coverage for atomic Hydra config mutations.
 *
 * Run: node packages/core/out/smoke/hydraConfigAtomicSmoke.js
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function waitForFile(filePath: string, child: ReturnType<typeof spawn>): void {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null) {
      throw new Error(`first config writer exited before acquiring the lock (code ${child.exitCode})`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for config writer signal at ${filePath}`);
    }
    sleepSync(10);
  }
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-config-atomic-'));
  const hydraHome = path.join(root, '.hydra');
  const configPath = path.join(hydraHome, 'config.json');
  const signalPath = path.join(root, 'first-writer-locked');
  const donePath = path.join(root, 'first-writer-done');
  const pathModule = path.resolve(__dirname, '..', 'core', 'path.js');
  const env = {
    ...process.env,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
  };

  fs.mkdirSync(hydraHome, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ share: { bucket: 'existing' } }, null, 2)}\n`, 'utf-8');

  const firstWriter = spawn(process.execPath, [
    '-e',
    `const fs=require('node:fs');const {updateHydraConfig}=require(process.argv[1]);const signal=process.argv[2];const done=process.argv[3];updateHydraConfig(config=>{fs.writeFileSync(signal,'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);return {...config,defaultAgent:'codex'}});fs.writeFileSync(done,'done');`,
    pathModule,
    signalPath,
    donePath,
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    waitForFile(signalPath, firstWriter);
    const secondWriter = spawnSync(process.execPath, [
      '-e',
      `const {updateHydraConfig}=require(process.argv[1]);updateHydraConfig(config=>({...config,agentCommands:{...(config.agentCommands||{}),claude:'claude'}}));`,
      pathModule,
    ], { env, encoding: 'utf-8' });
    assert.equal(secondWriter.status, 0, secondWriter.stderr || 'second config writer failed');

    waitForFile(donePath, firstWriter);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    assert.deepEqual(config.share, { bucket: 'existing' }, 'unrelated existing config survives concurrent updates');
    assert.equal(config.defaultAgent, 'codex', 'first writer mutation survives');
    assert.deepEqual(config.agentCommands, { claude: 'claude' }, 'second writer mutation survives');
    assert.equal(fs.existsSync(`${configPath}.lock`), false, 'config lock is released');
    assert.deepEqual(
      fs.readdirSync(hydraHome).filter(name => name.endsWith('.tmp')),
      [],
      'atomic updates leave no temp files',
    );
  } finally {
    if (!fs.existsSync(donePath) && firstWriter.exitCode === null) firstWriter.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('hydraConfigAtomicSmoke: ok');
}

main();
