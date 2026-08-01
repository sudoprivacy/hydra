// Thin client over the nexus VFS gRPC "agent plane" (the loopback sk--token bind).
//
// This is the low-level primitive both switchable planes (doc §5) build on: the
// tracking plane rides the generic `Call` RPC (this file); the message plane will add
// mailbox ops (Setattr/StreamWrite/StreamCollect) on the same client later.
//
// The wire contract is loaded dynamically from a vendored copy of nexus-vfs's
// `vfs.proto` (self-contained, no imports) so hydra does not depend on a sibling
// nexus-vfs checkout at runtime.

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';

// __dirname at runtime = <core>/out/core/transport/nexus  →  up 4  = <core>, then /proto.
const DEFAULT_PROTO_ROOT = path.join(__dirname, '..', '..', '..', '..', 'proto');
const PROTO_FILE = 'nexus/grpc/vfs/vfs.proto';

// loadSync is not free; cache the resolved service constructor per proto root.
const serviceCache = new Map<string, grpc.ServiceClientConstructor>();

function loadService(protoRoot: string): grpc.ServiceClientConstructor {
  const cached = serviceCache.get(protoRoot);
  if (cached) {
    return cached;
  }
  const def = protoLoader.loadSync(PROTO_FILE, {
    keepCase: true, // snake_case fields: auth_token, is_error, error_payload, …
    longs: String, // uint64 offsets as strings
    defaults: true,
    includeDirs: [protoRoot],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = grpc.loadPackageDefinition(def) as any;
  const Service = pkg.nexus.grpc.vfs.NexusVFSService as grpc.ServiceClientConstructor;
  serviceCache.set(protoRoot, Service);
  return Service;
}

export interface NexusVfsClientOptions {
  /** Agent-plane address, host:port (loopback token plane). Default 127.0.0.1:2129. */
  address?: string;
  /** sk- agent key. The agent plane always authenticates, so this is required in practice. */
  token?: string;
  /** Override the proto include dir (tests). */
  protoRoot?: string;
}

interface CallResponse {
  payload?: Buffer;
  is_error?: boolean;
}

/** A gRPC client for the nexus VFS agent plane; carries the sk- token on every Call. */
export class NexusVfsClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly token: string;

  constructor(options: NexusVfsClientOptions = {}) {
    this.token = options.token ?? '';
    const Service = loadService(options.protoRoot ?? DEFAULT_PROTO_ROOT);
    this.client = new Service(
      options.address ?? '127.0.0.1:2129',
      grpc.credentials.createInsecure(),
    );
  }

  /**
   * One kernel Call: `method` + JSON params -> parsed JSON result.
   * The Call rpc_codec wraps success values as `{"result": <value>}`; this unwraps it.
   * Rejects when the daemon flags `is_error`.
   */
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.client.Call(
        { method, payload: Buffer.from(JSON.stringify(params)), auth_token: this.token },
        (err: grpc.ServiceError | null, res: CallResponse) => {
          if (err) {
            reject(err);
            return;
          }
          const body =
            res.payload && res.payload.length
              ? JSON.parse(Buffer.from(res.payload).toString())
              : null;
          if (res.is_error) {
            reject(new Error(`${method}: ${JSON.stringify(body)}`));
            return;
          }
          resolve(
            body && typeof body === 'object' && 'result' in body ? body.result : body,
          );
        },
      );
    });
  }

  /** One typed VFS RPC returning `{is_error, error_payload}`; rejects on `is_error`. */
  private unary<Res>(rpc: string, req: Record<string, unknown>): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.client[rpc](
        req,
        (
          err: grpc.ServiceError | null,
          res: Res & { is_error?: boolean; error_payload?: Buffer },
        ) => {
          if (err) {
            reject(err);
            return;
          }
          if (res.is_error) {
            const msg =
              res.error_payload && res.error_payload.length
                ? Buffer.from(res.error_payload).toString()
                : '(no payload)';
            reject(new Error(`${rpc}: ${msg}`));
            return;
          }
          resolve(res);
        },
      );
    });
  }

  /** Create (idempotent) a wal-backed DT_STREAM mailbox at `path`. */
  async mkstream(path: string): Promise<void> {
    await this.unary('Setattr', {
      path,
      auth_token: this.token,
      entry_type: 4, // DT_STREAM
      io_profile: 'wal,memory',
    });
  }

  /** Append one frame to the DT_STREAM at `path`; returns the offset it landed at. */
  async streamWrite(path: string, data: Buffer): Promise<string> {
    const res = await this.unary<{ offset?: string }>('StreamWriteNowait', {
      path,
      data,
      auth_token: this.token,
    });
    return res.offset ?? '0';
  }

  /** Read the whole DT_STREAM at `path` (all frames concatenated). */
  async streamCollect(path: string): Promise<Buffer> {
    const res = await this.unary<{ data?: Buffer }>('StreamCollectAll', {
      path,
      auth_token: this.token,
    });
    return res.data && res.data.length ? Buffer.from(res.data) : Buffer.alloc(0);
  }

  /**
   * Read frames from `offset`. With `blocking`, the server waits up to `timeoutMs` for a
   * frame to appear (tail-follow, sys_watch under the hood); non-blocking returns
   * `eof=true` when nothing is ready. Returns the frame bytes + the cursor for next read.
   */
  async streamReadAt(
    path: string,
    offset: string,
    opts: { blocking?: boolean; timeoutMs?: number } = {},
  ): Promise<{ data: Buffer; nextOffset: string; eof: boolean }> {
    const res = await this.unary<{ data?: Buffer; next_offset?: string; eof?: boolean }>(
      'StreamReadAt',
      {
        path,
        offset,
        blocking: opts.blocking ?? false,
        timeout_ms: opts.timeoutMs ?? 0,
        auth_token: this.token,
      },
    );
    return {
      data: res.data && res.data.length ? Buffer.from(res.data) : Buffer.alloc(0),
      nextOffset: res.next_offset ?? offset,
      eof: res.eof ?? false,
    };
  }

  close(): void {
    this.client.close();
  }
}
