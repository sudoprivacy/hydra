/**
 * Smoke test: telemetry framework.
 *
 * Verifies:
 *   1. PostHogBackend is the default; ConsoleBackend on debug; NullBackend
 *      on opt-out — and `capture()` never throws regardless.
 *   2. ConsoleBackend appends a JSON line to telemetry.log and auto-attached
 *      props cannot be overridden by callers.
 *   3. HYDRA_TELEMETRY=0 (and "off"/"false") forces NullBackend even with
 *      debug enabled and never creates an anonymous-id.
 *   4. anonymous-id is generated when missing, reused when present, replaced
 *      when invalid, and survives an EEXIST race with a concurrent writer.
 *   5. capture() returns synchronously and a slow backend never blocks past
 *      timeoutMs (AbortSignal aborts the in-flight request).
 *   6. The first-run stderr notice fires exactly once.
 *   7. flush() awaits all in-flight capture() calls.
 *   8. normalizeAgentForTelemetry allowlists agent names.
 *   9. PostHogBackend.capture() forwards the right shape to the SDK
 *      (distinctId from anonymous_id, no anonymous_id duplicated as a prop).
 *  10. PostHogBackend honors HYDRA_POSTHOG_API_KEY and HYDRA_POSTHOG_HOST.
 *  11. TelemetryClient.flush() returns within ~1500ms even when the backend
 *      flush() never resolves (bounded race against an unref'd timer).
 *
 * Run:  node out/smoke/telemetrySmoke.js
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withTempHome(fn: (hydraHome: string) => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousHydraHome = process.env.HYDRA_HOME;
  const previousHydraConfig = process.env.HYDRA_CONFIG_PATH;
  const previousTelemetry = process.env.HYDRA_TELEMETRY;
  const previousTelemetryDebug = process.env.HYDRA_TELEMETRY_DEBUG;

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-telemetry-'));
  const hydraHome = path.join(tempHome, '.hydra');
  process.env.HOME = tempHome;
  process.env.HYDRA_HOME = hydraHome;
  delete process.env.HYDRA_CONFIG_PATH;
  delete process.env.HYDRA_TELEMETRY;
  delete process.env.HYDRA_TELEMETRY_DEBUG;

  try {
    await fn(hydraHome);
  } finally {
    process.env.HOME = previousHome;
    if (previousHydraHome === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = previousHydraHome;
    }
    if (previousHydraConfig === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = previousHydraConfig;
    }
    if (previousTelemetry === undefined) {
      delete process.env.HYDRA_TELEMETRY;
    } else {
      process.env.HYDRA_TELEMETRY = previousTelemetry;
    }
    if (previousTelemetryDebug === undefined) {
      delete process.env.HYDRA_TELEMETRY_DEBUG;
    } else {
      process.env.HYDRA_TELEMETRY_DEBUG = previousTelemetryDebug;
    }
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function captureStderr(): { restore: () => string } {
  const original = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  let captured = '';
  (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = (
    chunk: unknown,
  ): boolean => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  return {
    restore(): string {
      (process.stderr as unknown as { write: typeof original }).write = original;
      return captured;
    },
  };
}

async function testPostHogBackendIsDefault(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    const backend = telemetry.selectBackend();
    assert.ok(
      backend instanceof telemetry.PostHogBackend,
      'default backend should be PostHogBackend (no opt-out, no debug)',
    );
  });
}

async function testPostHogBackendCaptureShape(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    interface CapturedCall {
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }
    const calls: CapturedCall[] = [];
    let flushCount = 0;
    let factoryArgs: { apiKey: string; host: string } | null = null;
    const fakeClient = {
      capture(props: CapturedCall): void {
        calls.push(props);
      },
      async flush(): Promise<void> {
        flushCount += 1;
      },
    };

    const backend = new telemetry.PostHogBackend({
      apiKey: 'phc_test_key',
      host: 'https://test.posthog.example',
      clientFactory: (apiKey, host) => {
        factoryArgs = { apiKey, host };
        return fakeClient;
      },
    });

    const client = new telemetry.TelemetryClient({
      backend,
      anonymousId: '11111111-2222-4333-8444-555555555555',
      hydraVersion: '0.0.0-test',
    });
    client.capture('worker_created', { agent: 'claude' });
    await client.flush();

    assert.equal(calls.length, 1, 'expected exactly one PostHog capture call');
    const [first] = calls;
    assert.equal(first.event, 'worker_created');
    assert.equal(
      first.distinctId,
      '11111111-2222-4333-8444-555555555555',
      'distinctId must come from anonymous_id',
    );
    assert.equal(first.properties?.agent, 'claude');
    assert.equal(first.properties?.hydra_version, '0.0.0-test');
    assert.equal(first.properties?.platform, process.platform);
    assert.equal(first.properties?.node_version, process.version);
    assert.equal(
      Object.prototype.hasOwnProperty.call(first.properties ?? {}, 'anonymous_id'),
      false,
      'anonymous_id must NOT be duplicated as a property — PostHog already keys by distinctId',
    );
    assert.ok(flushCount >= 1, 'backend.flush() must drain the client');
    assert.deepEqual(
      factoryArgs,
      { apiKey: 'phc_test_key', host: 'https://test.posthog.example' },
      'factory must receive the configured apiKey and host',
    );
  });
}

async function testPostHogBackendEnvOverrides(): Promise<void> {
  await withTempHome(async () => {
    const previousKey = process.env.HYDRA_POSTHOG_API_KEY;
    const previousHost = process.env.HYDRA_POSTHOG_HOST;
    process.env.HYDRA_POSTHOG_API_KEY = 'phc_env_key';
    process.env.HYDRA_POSTHOG_HOST = 'https://eu.i.posthog.example';
    try {
      const telemetry = await import('../core/telemetry');
      telemetry.resetTelemetryForTesting();

      let factoryArgs: { apiKey: string; host: string } | null = null;
      const backend = new telemetry.PostHogBackend({
        clientFactory: (apiKey, host) => {
          factoryArgs = { apiKey, host };
          return {
            capture(): void {
              /* noop */
            },
            async flush(): Promise<void> {
              /* noop */
            },
          };
        },
      });
      const client = new telemetry.TelemetryClient({
        backend,
        anonymousId: 'fixed-test-id',
        hydraVersion: '0.0.0-test',
      });
      client.capture('worker_created', { agent: 'claude' });
      await client.flush();
      assert.deepEqual(
        factoryArgs,
        { apiKey: 'phc_env_key', host: 'https://eu.i.posthog.example' },
        'HYDRA_POSTHOG_API_KEY and HYDRA_POSTHOG_HOST must override the embedded defaults',
      );
    } finally {
      if (previousKey === undefined) {
        delete process.env.HYDRA_POSTHOG_API_KEY;
      } else {
        process.env.HYDRA_POSTHOG_API_KEY = previousKey;
      }
      if (previousHost === undefined) {
        delete process.env.HYDRA_POSTHOG_HOST;
      } else {
        process.env.HYDRA_POSTHOG_HOST = previousHost;
      }
    }
  });
}

async function testConsoleBackendWritesJsonLine(): Promise<void> {
  await withTempHome(async hydraHome => {
    process.env.HYDRA_TELEMETRY_DEBUG = '1';
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    const backend = telemetry.selectBackend();
    assert.ok(
      backend instanceof telemetry.ConsoleBackend,
      'HYDRA_TELEMETRY_DEBUG=1 should select ConsoleBackend',
    );

    const client = new telemetry.TelemetryClient();
    // Caller tries to override an auto-attached prop — must NOT win.
    client.capture('worker_created', {
      agent: 'claude',
      hydra_version: 'attacker-version',
    });
    await client.flush();

    const logPath = path.join(hydraHome, 'telemetry.log');
    assert.ok(fs.existsSync(logPath), 'telemetry.log must exist after capture()');

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'expected exactly one event line');

    const parsed = JSON.parse(lines[0]) as {
      event: string;
      properties: Record<string, unknown>;
      timestamp: string;
    };
    assert.equal(parsed.event, 'worker_created');
    assert.equal(parsed.properties.agent, 'claude');
    assert.equal(typeof parsed.properties.hydra_version, 'string');
    assert.notEqual(
      parsed.properties.hydra_version,
      'attacker-version',
      'callers must NOT be able to override the auto-attached hydra_version',
    );
    assert.equal(parsed.properties.platform, process.platform);
    assert.equal(parsed.properties.node_version, process.version);
    assert.match(
      parsed.properties.anonymous_id as string,
      UUID_V4_RE,
      'anonymous_id must be a UUIDv4',
    );
    assert.match(parsed.timestamp, /\d{4}-\d{2}-\d{2}T/);

    // anonymous-id file should be 0o600 (owner-only) when we created it.
    if (process.platform !== 'win32') {
      const stat = fs.statSync(path.join(hydraHome, 'anonymous-id'));
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `anonymous-id file mode should be 0o600 (got 0o${mode.toString(8)})`);
    }
  });
}

async function testOptOutForcesNullBackend(): Promise<void> {
  for (const value of ['0', 'off', 'OFF', 'false']) {
    await withTempHome(async hydraHome => {
      process.env.HYDRA_TELEMETRY = value;
      process.env.HYDRA_TELEMETRY_DEBUG = '1';
      const telemetry = await import('../core/telemetry');
      telemetry.resetTelemetryForTesting();

      const backend = telemetry.selectBackend();
      assert.ok(
        backend instanceof telemetry.NullBackend,
        `HYDRA_TELEMETRY=${value} must force NullBackend even when DEBUG=1`,
      );

      const client = new telemetry.TelemetryClient();
      client.capture('worker_created', { agent: 'claude' });
      await client.flush();

      assert.equal(
        fs.existsSync(path.join(hydraHome, 'telemetry.log')),
        false,
        `opted-out telemetry must not write logs (value=${value})`,
      );
      assert.equal(
        fs.existsSync(path.join(hydraHome, 'anonymous-id')),
        false,
        `opted-out telemetry must not create anonymous-id (value=${value})`,
      );
    });
  }
}

async function testAnonymousIdLifecycle(): Promise<void> {
  await withTempHome(async hydraHome => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    const idPath = path.join(hydraHome, 'anonymous-id');
    assert.equal(fs.existsSync(idPath), false, 'precondition: file should be missing');

    const first = telemetry.getAnonymousId();
    assert.match(first, UUID_V4_RE, 'must return a UUIDv4');
    assert.ok(fs.existsSync(idPath), 'file should be created after first call');

    const onDisk = fs.readFileSync(idPath, 'utf-8').trim();
    assert.equal(onDisk, first, 'on-disk content must match returned id');

    const second = telemetry.getAnonymousId();
    assert.equal(second, first, 'second call must reuse the persisted id');

    // Whitespace around a valid UUID should be trimmed and reused.
    const validUuid = '11111111-2222-4333-8444-555555555555';
    fs.writeFileSync(idPath, `   ${validUuid}   \n`, { mode: 0o600 });
    const trimmedReuse = telemetry.getAnonymousId();
    assert.equal(trimmedReuse, validUuid, 'must trim and reuse a valid UUID');
  });
}

async function testInvalidUuidIsReplaced(): Promise<void> {
  await withTempHome(async hydraHome => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    fs.mkdirSync(hydraHome, { recursive: true });
    const idPath = path.join(hydraHome, 'anonymous-id');
    fs.writeFileSync(idPath, 'totally-not-a-uuid\n', 'utf-8');

    const id = telemetry.getAnonymousId();
    assert.match(id, UUID_V4_RE, 'invalid contents must be replaced with a fresh UUIDv4');

    const onDisk = fs.readFileSync(idPath, 'utf-8').trim();
    assert.equal(onDisk, id, 'replacement must be persisted');
  });
}

async function testNonV4UuidIsReplaced(): Promise<void> {
  // A syntactically valid v3 UUID must still be replaced — we only persist
  // UUIDv4 values, both because the docs claim v4 and because v3/v5 UUIDs
  // are derived from a name+namespace and would not be anonymous.
  const v3Uuid = '00000000-0000-3000-8000-000000000000';
  await withTempHome(async hydraHome => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    fs.mkdirSync(hydraHome, { recursive: true });
    const idPath = path.join(hydraHome, 'anonymous-id');
    fs.writeFileSync(idPath, `${v3Uuid}\n`, 'utf-8');

    const id = telemetry.getAnonymousId();
    assert.notEqual(id, v3Uuid, 'a v3 UUID must not be reused');
    assert.match(id, UUID_V4_RE, 'replacement must be a UUIDv4');
    const onDisk = fs.readFileSync(idPath, 'utf-8').trim();
    assert.equal(onDisk, id, 'replacement must be persisted');
  });
}

async function testEexistRace(): Promise<void> {
  await withTempHome(async hydraHome => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    fs.mkdirSync(hydraHome, { recursive: true });
    const idPath = path.join(hydraHome, 'anonymous-id');

    // Mutate the underlying CJS fs export so the production module's
    // `import * as fs from 'fs'` namespace reflects the patch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsCjs = require('fs') as typeof fs;
    const realWriteFileSync = fsCjs.writeFileSync;
    const competitorId = '99999999-8888-4777-8666-555555555555';
    let intercepted = false;
    fsCjs.writeFileSync = ((
      target: Parameters<typeof fs.writeFileSync>[0],
      data: Parameters<typeof fs.writeFileSync>[1],
      options?: Parameters<typeof fs.writeFileSync>[2],
    ): void => {
      if (!intercepted && target === idPath) {
        intercepted = true;
        // Simulate a concurrent process winning the create race.
        realWriteFileSync(idPath, `${competitorId}\n`, { flag: 'w', mode: 0o600 });
        const err = new Error('EEXIST: file already exists') as Error & { code?: string };
        err.code = 'EEXIST';
        throw err;
      }
      return realWriteFileSync(target, data, options);
    }) as typeof fs.writeFileSync;

    try {
      const id = telemetry.getAnonymousId();
      assert.equal(id, competitorId, 'EEXIST must yield to the concurrent writer rather than overwrite');
      const onDisk = fs.readFileSync(idPath, 'utf-8').trim();
      assert.equal(onDisk, competitorId, 'persisted id must remain the concurrent writer');
    } finally {
      fsCjs.writeFileSync = realWriteFileSync;
    }
    assert.ok(intercepted, 'EEXIST interceptor must have fired');
  });
}

async function testFirstRunNoticeFiresOnce(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    const recorder = captureStderr();
    try {
      const first = telemetry.getAnonymousId();
      const second = telemetry.getAnonymousId();
      assert.equal(first, second, 'second call must reuse persisted id');
    } finally {
      const stderr = recorder.restore();
      const occurrences = (stderr.match(/Hydra collects anonymous usage stats/g) ?? []).length;
      assert.equal(occurrences, 1, `first-run notice must fire exactly once (got ${occurrences})`);
      assert.match(
        stderr,
        /https:\/\/github\.com\/sudoprivacy\/hydra#telemetry/,
        'first-run notice must include the README link',
      );
    }
  });
}

async function testCaptureIsNonBlocking(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    const slowBackend: import('../core/telemetry').TelemetryBackend = {
      capture(_event, _properties, signal): Promise<void> {
        return new Promise<void>(resolve => {
          // Refed timer — abort signal MUST clear it so the test process
          // exits promptly. This is also the contract a real backend
          // (e.g. an HTTP request) is expected to honor.
          const timer = setTimeout(resolve, 60_000);
          if (signal) {
            const onAbort = (): void => {
              clearTimeout(timer);
              resolve();
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      },
    };

    const client = new telemetry.TelemetryClient({
      backend: slowBackend,
      anonymousId: 'fixed-test-id',
      hydraVersion: '0.0.0-test',
      timeoutMs: 50,
    });

    const start = process.hrtime.bigint();
    for (let i = 0; i < 10; i += 1) {
      client.capture('worker_created', { agent: 'claude' });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    assert.ok(
      elapsedMs < 50,
      `capture() must return synchronously without awaiting backend (elapsed=${elapsedMs.toFixed(2)}ms)`,
    );

    // flush() must complete bounded by timeoutMs even with the slow backend.
    const flushStart = process.hrtime.bigint();
    await client.flush();
    const flushElapsedMs = Number(process.hrtime.bigint() - flushStart) / 1_000_000;
    assert.ok(
      flushElapsedMs < 500,
      `flush() must respect timeoutMs (elapsed=${flushElapsedMs.toFixed(2)}ms)`,
    );

    const throwingBackend: import('../core/telemetry').TelemetryBackend = {
      capture(): never {
        throw new Error('intentional backend explosion');
      },
    };
    const safeClient = new telemetry.TelemetryClient({
      backend: throwingBackend,
      anonymousId: 'fixed-test-id',
      hydraVersion: '0.0.0-test',
    });
    assert.doesNotThrow(() => safeClient.capture('worker_deleted'));
    await safeClient.flush();
  });
}

async function testFlushAwaitsInflight(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    let observed = 0;
    const recordingBackend: import('../core/telemetry').TelemetryBackend = {
      async capture(): Promise<void> {
        await new Promise<void>(resolve => {
          setTimeout(() => {
            observed += 1;
            resolve();
          }, 30);
        });
      },
    };

    const client = new telemetry.TelemetryClient({
      backend: recordingBackend,
      anonymousId: 'fixed-test-id',
      hydraVersion: '0.0.0-test',
      timeoutMs: 500,
    });

    for (let i = 0; i < 5; i += 1) {
      client.capture('worker_created', { agent: 'claude' });
    }

    // Without flush, the events are still in-flight.
    assert.equal(observed, 0, 'precondition: no events should have completed yet');

    await client.flush();
    assert.equal(observed, 5, 'flush() must await every in-flight capture');
  });
}

async function testFlushTimeoutOnHungBackend(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    // Backend whose flush() never resolves — simulates a stuck HTTP
    // request after the SDK's request timeout fails to fire. The
    // TelemetryClient.flush() race must still return within ~1500ms.
    const hungBackend: import('../core/telemetry').TelemetryBackend = {
      capture(): void {
        /* no-op */
      },
      flush: () => new Promise<void>(() => {
        /* never resolves */
      }),
    };

    const client = new telemetry.TelemetryClient({
      backend: hungBackend,
      anonymousId: 'fixed-test-id',
      hydraVersion: '0.0.0-test',
    });
    client.capture('worker_created', { agent: 'claude' });

    // Bounded race uses an unref'd timer so it doesn't add a refed handle
    // in production — the SDK's in-flight HTTP socket already keeps the
    // event loop alive long enough for the timer to fire. In this isolated
    // test there's no such handle, so we hold a refed watchdog for the
    // duration of the assertion to mimic that condition.
    const watchdog = setTimeout(() => {
      /* refed; cleared below */
    }, 5_000);
    try {
      const start = Date.now();
      await client.flush();
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 2500,
        `flush() must return within ~1500ms even with a hung backend (elapsed=${elapsed}ms)`,
      );
    } finally {
      clearTimeout(watchdog);
    }
  });
}

async function testNormalizeAgent(): Promise<void> {
  const telemetry = await import('../core/telemetry');
  for (const known of ['claude', 'codex', 'gemini', 'antigravity']) {
    assert.equal(telemetry.normalizeAgentForTelemetry(known), known);
  }
  assert.equal(telemetry.normalizeAgentForTelemetry('custom'), 'custom');
  assert.equal(telemetry.normalizeAgentForTelemetry('/some/path/to/binary'), 'custom');
  assert.equal(telemetry.normalizeAgentForTelemetry('user@host'), 'custom');
  assert.equal(telemetry.normalizeAgentForTelemetry(undefined), 'unknown');
  assert.equal(telemetry.normalizeAgentForTelemetry(''), 'unknown');
  assert.equal(telemetry.normalizeAgentForTelemetry('   '), 'unknown');
}

async function testHydraDirIsTightened(): Promise<void> {
  if (process.platform === 'win32') {
    return; // POSIX-only: Windows does not honor numeric modes
  }
  await withTempHome(async hydraHome => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    fs.mkdirSync(hydraHome, { recursive: true, mode: 0o755 });
    fs.chmodSync(hydraHome, 0o755);
    const before = fs.statSync(hydraHome).mode & 0o777;
    assert.equal(before, 0o755, 'precondition: dir starts at 0o755');

    telemetry.getAnonymousId();
    const after = fs.statSync(hydraHome).mode & 0o777;
    assert.equal(
      after,
      0o700,
      `existing ~/.hydra dir must be tightened to 0o700 (got 0o${after.toString(8)})`,
    );
  });
}

async function testPeekTelemetryStaysNullWithoutCapture(): Promise<void> {
  await withTempHome(async () => {
    // The lazy-instantiation contract is independent of backend; pin to
    // NullBackend so this test never attempts a real PostHog network call.
    process.env.HYDRA_TELEMETRY = '0';
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();

    assert.equal(telemetry.peekTelemetry(), null, 'fresh process should have no client');

    // Reading anonymous id directly is a low-level helper and does not
    // count as "command captured an event".
    telemetry.getAnonymousId();
    assert.equal(
      telemetry.peekTelemetry(),
      null,
      'getAnonymousId must NOT instantiate the shared client',
    );

    telemetry.getTelemetry().capture('worker_created', { agent: 'claude' });
    assert.notEqual(
      telemetry.peekTelemetry(),
      null,
      'after capture(), peekTelemetry must return the client',
    );

    await telemetry.getTelemetry().flush();
  });
}

async function testHelpDoesNotCreateAnonymousId(): Promise<void> {
  // Spawn a fresh node process and invoke the CLI's --help. With no
  // capture site reached, the beforeExit handler must skip flush and the
  // anonymous-id file must not exist.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-help-'));
  const hydraHome = path.join(tempHome, '.hydra');
  const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');
  try {
    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      env: {
        ...process.env,
        HOME: tempHome,
        HYDRA_HOME: hydraHome,
        // Worst case: debug enabled. With the lazy beforeExit fix, even
        // this should not trigger anonymous-id creation on a help-only run.
        HYDRA_TELEMETRY_DEBUG: '1',
        HYDRA_TELEMETRY: '',
      },
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, `hydra --help should exit 0 (got ${result.status})\n${result.stderr ?? ''}`);
    assert.equal(
      fs.existsSync(path.join(hydraHome, 'anonymous-id')),
      false,
      `anonymous-id must NOT be created on a help-only run (stderr=${result.stderr ?? ''})`,
    );
    assert.equal(
      fs.existsSync(path.join(hydraHome, 'telemetry.log')),
      false,
      'telemetry.log must NOT be created on a help-only run',
    );
  } finally {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function testGeneratedUuidIsRfcShape(): Promise<void> {
  await withTempHome(async () => {
    const telemetry = await import('../core/telemetry');
    telemetry.resetTelemetryForTesting();
    const id = telemetry.getAnonymousId();
    assert.match(id, UUID_RE, 'generated id must be a UUID');
  });
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['testPostHogBackendIsDefault', testPostHogBackendIsDefault],
    ['testPostHogBackendCaptureShape', testPostHogBackendCaptureShape],
    ['testPostHogBackendEnvOverrides', testPostHogBackendEnvOverrides],
    ['testConsoleBackendWritesJsonLine', testConsoleBackendWritesJsonLine],
    ['testOptOutForcesNullBackend', testOptOutForcesNullBackend],
    ['testAnonymousIdLifecycle', testAnonymousIdLifecycle],
    ['testInvalidUuidIsReplaced', testInvalidUuidIsReplaced],
    ['testNonV4UuidIsReplaced', testNonV4UuidIsReplaced],
    ['testEexistRace', testEexistRace],
    ['testHydraDirIsTightened', testHydraDirIsTightened],
    ['testPeekTelemetryStaysNullWithoutCapture', testPeekTelemetryStaysNullWithoutCapture],
    ['testHelpDoesNotCreateAnonymousId', testHelpDoesNotCreateAnonymousId],
    ['testFirstRunNoticeFiresOnce', testFirstRunNoticeFiresOnce],
    ['testCaptureIsNonBlocking', testCaptureIsNonBlocking],
    ['testFlushAwaitsInflight', testFlushAwaitsInflight],
    ['testFlushTimeoutOnHungBackend', testFlushTimeoutOnHungBackend],
    ['testNormalizeAgent', testNormalizeAgent],
    ['testGeneratedUuidIsRfcShape', testGeneratedUuidIsRfcShape],
  ];
  for (const [name, fn] of tests) {
    process.stdout.write(`  - ${name} ... `);
    await fn();
    process.stdout.write('ok\n');
  }
  console.log('telemetrySmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
