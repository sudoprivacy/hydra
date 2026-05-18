import * as crypto from 'crypto';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { PostHog } from 'posthog-node';
import { getHydraHome } from './path';

type ErrnoLike = Error & { code?: string };

export type TelemetryProperties = Record<string, unknown>;

export interface TelemetryBackend {
  capture(
    event: string,
    properties: TelemetryProperties,
    signal?: AbortSignal,
  ): void | Promise<void>;
  flush?(): Promise<void>;
}

const ANONYMOUS_ID_FILENAME = 'anonymous-id';
const TELEMETRY_LOG_FILENAME = 'telemetry.log';
const DEFAULT_TIMEOUT_MS = 500;
// Hard cap on how long TelemetryClient.flush() will await the backend's
// flush()/shutdown(). A hung HTTP request must never keep the CLI alive
// past this window; the bounded race below races the backend against an
// unref'd timer, so process exit is not blocked even if the network stalls.
const FLUSH_TIMEOUT_MS = 1500;
const TELEMETRY_README_URL = 'https://github.com/joezhoujinjing/hydra#telemetry';

const FIRST_RUN_NOTICE =
  'Hydra collects anonymous usage stats to improve the tool. ' +
  `Set HYDRA_TELEMETRY=0 to opt out. See ${TELEMETRY_README_URL}.`;

// UUIDv4 only: position 14 must be `4`, position 19 must be 8/9/a/b.
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KNOWN_AGENTS = new Set(['claude', 'codex', 'gemini', 'sudocode']);

export function normalizeAgentForTelemetry(agent: string | undefined | null): string {
  if (typeof agent !== 'string' || !agent.trim()) {
    return 'unknown';
  }
  return KNOWN_AGENTS.has(agent) ? agent : 'custom';
}

function readPersistedAnonymousId(idPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(idPath, 'utf-8');
  } catch (err) {
    if ((err as ErrnoLike).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  const trimmed = raw.trim();
  return UUID_V4_REGEX.test(trimmed) ? trimmed : null;
}

function ensureHydraDir(): string {
  const home = getHydraHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Tighten an already-existing directory too. Best-effort: chmod can fail
  // on shared/CI filesystems (EPERM), Windows (no POSIX modes), or when
  // we are not the owner — none of which should crash the CLI.
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // ignore — we will still return the directory and let downstream
    // writes fail loudly if the permissions actually prevent them.
  }
  return home;
}

export function getAnonymousId(): string {
  const home = ensureHydraDir();
  const idPath = path.join(home, ANONYMOUS_ID_FILENAME);

  const existing = readPersistedAnonymousId(idPath);
  if (existing) {
    return existing;
  }

  // Either missing or invalid. If a stale file exists, drop it so the
  // exclusive-create write below can succeed.
  if (fs.existsSync(idPath)) {
    try {
      fs.unlinkSync(idPath);
    } catch {
      // best-effort; the wx write below may still race a concurrent writer
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = crypto.randomUUID();
    try {
      fs.writeFileSync(idPath, `${candidate}\n`, { flag: 'wx', mode: 0o600 });
      try {
        process.stderr.write(`${FIRST_RUN_NOTICE}\n`);
      } catch {
        // never block the CLI on a failed stderr write
      }
      return candidate;
    } catch (err) {
      const code = (err as ErrnoLike).code;
      if (code !== 'EEXIST') {
        throw err;
      }
      // A concurrent process won the create race. Prefer their id if it is
      // valid; otherwise replace the bad file and retry once.
      const concurrent = readPersistedAnonymousId(idPath);
      if (concurrent) {
        return concurrent;
      }
      try {
        fs.unlinkSync(idPath);
      } catch {
        // best-effort
      }
    }
  }

  // Could not persist (filesystem hostile). Return an ephemeral id so the
  // caller is not blocked; next run will retry.
  return crypto.randomUUID();
}

function safeGetAnonymousId(): string {
  try {
    return getAnonymousId();
  } catch {
    return '';
  }
}

export class NullBackend implements TelemetryBackend {
  capture(_event: string, _properties: TelemetryProperties, _signal?: AbortSignal): void {
    // intentional no-op; ignores AbortSignal
    void _event;
    void _properties;
    void _signal;
  }

  async flush(): Promise<void> {
    // nothing buffered
  }
}

export class ConsoleBackend implements TelemetryBackend {
  private readonly logPath: string;

  constructor(logPath?: string) {
    this.logPath = logPath ?? path.join(getHydraHome(), TELEMETRY_LOG_FILENAME);
  }

  async capture(
    event: string,
    properties: TelemetryProperties,
    _signal?: AbortSignal,
  ): Promise<void> {
    void _signal; // local file write is fast; abort is best-effort and not honored
    const line = `${JSON.stringify({
      event,
      properties,
      timestamp: new Date().toISOString(),
    })}\n`;
    await fsPromises.mkdir(path.dirname(this.logPath), { recursive: true });
    await fsPromises.appendFile(this.logPath, line, 'utf-8');
  }

  async flush(): Promise<void> {
    // appendFile is awaited per-event; nothing additional to drain
  }
}

// PostHog project ingest key. PostHog "phc_" project keys are write-only,
// public ingestion tokens — same security model as Mixpanel tokens or Sentry
// DSNs — and are designed to be embedded in distributed clients.
const POSTHOG_PROJECT_API_KEY = 'phc_wciwVJJYnCTrYiKJtroBkFyDF8xLh6giLZQjhpQ67Dky';
const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';

interface PostHogClientLike {
  capture(props: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  flush(): Promise<void>;
  // posthog-node@5 exposes a public `shutdown()` that drains the queue,
  // cancels in-flight retries, and tears down resources — the recommended
  // call for short-lived processes. We prefer it when available and fall
  // back to flush() so test doubles only need to implement one of the two.
  shutdown?(shutdownTimeoutMs?: number): Promise<void>;
}

export type PostHogClientFactory = (apiKey: string, host: string) => PostHogClientLike;

export interface PostHogBackendOptions {
  apiKey?: string;
  host?: string;
  clientFactory?: PostHogClientFactory;
}

export class PostHogBackend implements TelemetryBackend {
  private readonly apiKey: string;
  private readonly host: string;
  private readonly clientFactory: PostHogClientFactory;
  private client: PostHogClientLike | null = null;

  constructor(options: PostHogBackendOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.HYDRA_POSTHOG_API_KEY ?? POSTHOG_PROJECT_API_KEY;
    this.host = options.host ?? process.env.HYDRA_POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST;
    this.clientFactory = options.clientFactory ?? defaultPostHogClientFactory;
  }

  capture(event: string, properties: TelemetryProperties, _signal?: AbortSignal): void {
    // posthog-node@5 does not accept an AbortSignal on capture() — capture is
    // synchronous enqueue + async background flush. The TelemetryClient
    // wrapper still bounds total wait via its 500ms timeout, so a stuck
    // network request cannot keep the CLI alive past flush().
    void _signal;
    try {
      const client = this.ensureClient();
      const { anonymous_id, ...rest } = properties as { anonymous_id?: unknown } & TelemetryProperties;
      const distinctId = typeof anonymous_id === 'string' && anonymous_id ? anonymous_id : 'anonymous';
      client.capture({ distinctId, event, properties: rest });
    } catch {
      // never throw from a backend
    }
  }

  async flush(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      if (typeof this.client.shutdown === 'function') {
        await this.client.shutdown();
      } else {
        await this.client.flush();
      }
    } catch {
      // best-effort
    }
  }

  private ensureClient(): PostHogClientLike {
    if (!this.client) {
      this.client = this.clientFactory(this.apiKey, this.host);
    }
    return this.client;
  }
}

function defaultPostHogClientFactory(apiKey: string, host: string): PostHogClientLike {
  // CLI-tuned config: every event matters and we exit fast, so disable
  // batching (flushAt: 1) and the periodic timer (flushInterval: 0) so a
  // single explicit flush() drains the queue without leaving a refed timer
  // that would prevent process exit. requestTimeout caps each underlying
  // HTTP request so a stalled network can't outlive the wrapper race.
  return new PostHog(apiKey, {
    host,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: FLUSH_TIMEOUT_MS,
  });
}

export interface TelemetryClientOptions {
  backend?: TelemetryBackend;
  hydraVersion?: string;
  anonymousId?: string;
  timeoutMs?: number;
}

function loadPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function selectBackend(): TelemetryBackend {
  const optOut = (process.env.HYDRA_TELEMETRY ?? '').trim().toLowerCase();
  if (optOut === '0' || optOut === 'off' || optOut === 'false') {
    return new NullBackend();
  }
  if (process.env.HYDRA_TELEMETRY_DEBUG === '1') {
    return new ConsoleBackend();
  }
  return new PostHogBackend();
}

export class TelemetryClient {
  private readonly backend: TelemetryBackend;
  private readonly timeoutMs: number;
  private readonly defaults: TelemetryProperties;
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: TelemetryClientOptions = {}) {
    this.backend = options.backend ?? selectBackend();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const isNoOp = this.backend instanceof NullBackend;
    this.defaults = {
      hydra_version: options.hydraVersion ?? loadPackageVersion(),
      platform: process.platform,
      node_version: process.version,
      anonymous_id: options.anonymousId ?? (isNoOp ? '' : safeGetAnonymousId()),
    };
  }

  capture(event: string, properties: TelemetryProperties = {}): void {
    // Auto-attached props win — callers cannot override hydra_version,
    // platform, node_version, or anonymous_id by passing them as props.
    const payload: TelemetryProperties = { ...properties, ...this.defaults };
    const tracker = this.scheduleDispatch(event, payload);
    this.inflight.add(tracker);
    void tracker.finally(() => this.inflight.delete(tracker));
  }

  async flush(): Promise<void> {
    const pending = Array.from(this.inflight);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    if (this.backend.flush) {
      // Race the backend's flush against an unref'd timer so a hung HTTP
      // request can never keep the CLI alive past FLUSH_TIMEOUT_MS. If the
      // timer wins, the in-flight request is left to drain in the
      // background; the unref means it won't block process exit.
      const timeoutPromise = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.resolve(this.backend.flush()), timeoutPromise]);
      } catch {
        // never propagate — flush is best-effort
      }
    }
  }

  private scheduleDispatch(event: string, properties: TelemetryProperties): Promise<void> {
    return new Promise<void>(resolve => {
      // setImmediate so capture() always returns synchronously.
      setImmediate(() => {
        this.dispatch(event, properties).then(resolve, resolve);
      });
    });
  }

  private async dispatch(event: string, properties: TelemetryProperties): Promise<void> {
    const controller = new AbortController();
    // Keep the timer refed so it actually fires when a backend hangs and
    // there is no other refed work in the event loop. We always
    // clearTimeout in the finally block, so a fast backend never costs
    // the CLI extra wall-clock time.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = this.backend.capture(event, properties, controller.signal);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        await new Promise<void>(resolve => {
          let settled = false;
          const settle = (): void => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          Promise.resolve(result).then(settle, settle);
          if (controller.signal.aborted) {
            settle();
          } else {
            controller.signal.addEventListener('abort', settle, { once: true });
          }
        });
      }
    } catch {
      // backends must not crash the CLI
    } finally {
      clearTimeout(timer);
    }
  }
}

let sharedClient: TelemetryClient | null = null;

export function getTelemetry(): TelemetryClient {
  if (!sharedClient) {
    sharedClient = new TelemetryClient();
  }
  return sharedClient;
}

/**
 * Returns the active client only if `getTelemetry()` has already been called
 * this process. Lets `beforeExit` skip the flush (and the implicit
 * anonymous-id creation) on commands that never captured an event — e.g.
 * `hydra --help`, `hydra list`, etc.
 */
export function peekTelemetry(): TelemetryClient | null {
  return sharedClient;
}

export function resetTelemetryForTesting(): void {
  sharedClient = null;
}
