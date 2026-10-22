import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Frame = Record<string, unknown>;
const root = path.resolve(__dirname, '../../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-agent-runtime-cli-'));
const config = path.join(directory, 'runtime.json');
fs.writeFileSync(config, JSON.stringify({
  scodeArgv: [process.execPath, path.join(root, 'scripts/fixtures/scode-acp-agent.mjs')],
  workspace: directory, acpSessionId: 'cli-native-history', closeTimeoutMs: 200,
}), { mode: 0o600 });

function connect(configPath = config, extraArgs: string[] = []) {
  const child = spawn(process.execPath, [path.join(root, 'packages/cli/out/cli/index.js'),
    'agent-runtime', 'connect', '--config', configPath, '--manual-permissions', '--manual-questions', ...extraArgs], {
    env: { ...process.env, HYDRA_HOME: path.join(directory, 'home') }, windowsHide: true,
    stdio: ['pipe','pipe','pipe'],
  });
  const frames: Frame[] = [];
  let buffered = '';
  let stderr = '';
  child.stdout.on('data', bytes => {
    buffered += String(bytes);
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n');
      const line = buffered.slice(0,index); buffered = buffered.slice(index+1);
      if (line.trim()) frames.push(JSON.parse(line) as Frame);
    }
  });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  async function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now()+5000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Connector exited early: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Connector deadline: ${stderr}`);
  }
  return { child,frames,exited,wait,send: (command: Frame) => child.stdin.write(JSON.stringify(command)+'\n') };
}

function event(frame: Frame): Record<string, unknown> {
  return frame.type === 'event' ? frame.event as Record<string,unknown> : {};
}

async function boundedExit(exited: Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([exited,new Promise<never>((_,reject) => {
      timer=setTimeout(() => reject(new Error('Foreground runtime did not exit')),3000);
    })]);
  } finally { clearTimeout(timer!); }
}

async function main(): Promise<void> {
  const client = connect();
  try {
    await client.wait(frame => frame.type === 'ready');
    client.send({ id:'p1',op:'prompt',text:'hello' });
    await client.wait(frame => frame.type === 'result' && frame.id === 'p1');
    await client.wait(frame => event(frame).type === 'notification'
      && JSON.stringify(event(frame).notification).includes('Unsolicited idle peer event'));
    assert.equal(client.child.exitCode,null,'foreground host must survive prompt completion');
    client.send({ id:'p2',op:'prompt',text:'permission' });
    const permission = event(await client.wait(frame => event(frame).type === 'permission' && event(frame).phase === 'requested'));
    const request = permission.permission as { id:string };
    client.send({ id:'a2',op:'permission',requestId:request.id,optionId:'reject-once' });
    await client.wait(frame => frame.type === 'result' && frame.id === 'p2');
    client.send({ id:'p3',op:'prompt',text:'question' });
    const question = event(await client.wait(frame => event(frame).type === 'question' && event(frame).phase === 'requested'));
    client.send({ id:'a3',op:'question',requestId:(question.question as {id:string}).id,
      answers:[{ id:'action',value:'revise' }] });
    const answered = await client.wait(frame => frame.type === 'result' && frame.id === 'p3');
    assert.match(JSON.stringify(answered),/revise/);
    client.send({ id:'stop',op:'stop' });
    await client.wait(frame => frame.type === 'result' && frame.id === 'stop');
    assert.equal(await boundedExit(client.exited),0);
  } finally { if (client.child.exitCode === null) client.child.kill('SIGKILL'); }

  const eof = connect();
  try {
    await eof.wait(frame => frame.type === 'ready');
    eof.child.stdin.end();
    assert.equal(await boundedExit(eof.exited),0,'EOF must close only the foreground-owned child');
  } finally { if (eof.child.exitCode === null) eof.child.kill('SIGKILL'); }

  const startupConfig = path.join(directory, 'startup.json');
  const original = JSON.parse(fs.readFileSync(config, 'utf8'));
  fs.writeFileSync(startupConfig, JSON.stringify({ ...original,
    scodeArgv: [...original.scodeArgv, 'load-permission'], startupTimeoutMs: 20000,
  }));
  const startup = connect(startupConfig);
  try {
    const request = event(await startup.wait(frame => event(frame).type === 'permission' && event(frame).phase === 'requested'));
    assert.ok(!startup.frames.some(frame => frame.type === 'ready'));
    startup.send({ id: 'startup-answer', op: 'permission', requestId: (request.permission as {id:string}).id, optionId: 'reject-once' });
    await startup.wait(frame => frame.type === 'ready');
    startup.child.stdin.end();
    assert.equal(await boundedExit(startup.exited), 0);
  } finally { if (startup.child.exitCode === null) startup.child.kill('SIGKILL'); }

  const startupEof = connect(startupConfig);
  try {
    await startupEof.wait(frame => event(frame).type === 'permission' && event(frame).phase === 'requested');
    startupEof.child.stdin.end();
    // Startup cancellation is a failed connect, but must not wait for the 20s timeout.
    assert.equal(await boundedExit(startupEof.exited), 1);
  } finally { if (startupEof.child.exitCode === null) startupEof.child.kill('SIGKILL'); }

  const once = connect(config, ['--once', 'hello']);
  try { assert.equal(await boundedExit(once.exited), 1, '--once must reject manual input flags'); }
  finally { if (once.child.exitCode === null) once.child.kill('SIGKILL'); }
  console.log('PASS agent runtime CLI: idle delivery, manual permission/question, explicit stop and EOF');
}
void main().catch(error => { console.error(error); process.exitCode=1; }).finally(() => {
  // This exact disposable directory was created by this smoke and contains no caller workspace.
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
      || !path.basename(directory).startsWith('hydra-agent-runtime-cli-')) {
    throw new Error('Refusing cleanup outside the owned smoke directory');
  }
  fs.rmSync(directory,{ recursive:true,force:true });
});
