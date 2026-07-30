// PoC increment 1 — TypeScript/Node nexus A2A mailbox client.
//
// Proves hydra (TS) can talk to the nexus A2A substrate end to end: it dials the
// loopback agent plane (the sk--token VFS plane, default 127.0.0.1:2129) and does
// mkstream / send / collect on a chat-with-me DT_STREAM — the TS equivalent of the
// Rust `mailbox_cli` example. Dynamic proto load (@grpc/proto-loader), no codegen.
//
// This is the core capability the future `transport-a2a` messaging backend wraps
// (doc §5): sendMessage -> send(), worker->copilot attention -> send()+watch on
// the copilot's mailbox. Kept a spike until the switchable abstraction lands.
//
//   node mailbox.mjs                       # round-trip self-test (mkstream/send/collect)
//   SK=sk-... MBOX=/agents/x/chat-with-me MSG="hi" node mailbox.mjs

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const DT_STREAM = 4;

/** Minimal nexus A2A mailbox client over the VFS gRPC agent plane. */
export class NexusMailbox {
  /**
   * @param {object} [opts]
   * @param {string} [opts.address]   agent-plane address (host:port)
   * @param {string} [opts.token]     sk- agent key; "" when the plane is auth-off
   * @param {string} [opts.protoRoot] nexus-vfs `proto/` dir (include root)
   */
  constructor({ address = "127.0.0.1:2129", token = "", protoRoot } = {}) {
    this.token = token;
    const root =
      protoRoot ?? "C:/Users/songym/cursor-projects/nexus-vfs/proto";
    const def = protoLoader.loadSync("nexus/grpc/vfs/vfs.proto", {
      keepCase: true, // snake_case fields: auth_token, entry_type, io_profile, is_error…
      longs: String, // uint64 offset as string
      defaults: true,
      includeDirs: [root],
    });
    const pkg = grpc.loadPackageDefinition(def);
    const Svc = pkg.nexus.grpc.vfs.NexusVFSService;
    this.client = new Svc(address, grpc.credentials.createInsecure());
  }

  #call(method, req) {
    return new Promise((resolve, reject) => {
      this.client[method](req, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  static #errText(payload) {
    return payload && payload.length ? Buffer.from(payload).toString() : "";
  }

  static #check(res, op) {
    if (res.is_error) throw new Error(`${op}: ${NexusMailbox.#errText(res.error_payload)}`);
    return res;
  }

  /** Create (idempotent) a wal-backed DT_STREAM mailbox at `path`. */
  async mkstream(path) {
    const res = await this.#call("Setattr", {
      path,
      auth_token: this.token,
      entry_type: DT_STREAM,
      io_profile: "wal,memory",
    });
    return NexusMailbox.#check(res, "mkstream");
  }

  /**
   * Append one A2A envelope. The message is a JSON envelope `{from, to, body}`;
   * the kernel stamp hook (rust/a2a) parses it on every chat-with-me write and
   * overwrites `from` with the caller's authenticated agent_id — so a sender
   * cannot forge authorship. `from` here is only a placeholder.
   */
  async send(path, { to = null, body, from = "(claimed-by-sender)" }) {
    const frame = JSON.stringify({ from, to, body });
    const res = await this.#call("StreamWriteNowait", {
      path,
      data: Buffer.from(frame),
      auth_token: this.token,
    });
    return NexusMailbox.#check(res, "send").offset;
  }

  /**
   * Read the whole stream (all frames, concatenated). The stamp hook re-serializes
   * each envelope, so single-message streams decode with one `JSON.parse`; frame
   * delimiting for multi-message reads is an increment-2 concern (the messaging seam).
   */
  async collect(path) {
    const res = await this.#call("StreamCollectAll", {
      path,
      auth_token: this.token,
    });
    return Buffer.from(NexusMailbox.#check(res, "collect").data ?? Buffer.alloc(0)).toString();
  }

  close() {
    this.client.close();
  }
}

async function main() {
  const mbox = new NexusMailbox({
    address: process.env.ADDR ?? "127.0.0.1:2129",
    token: process.env.SK ?? "",
    protoRoot: process.env.PROTO_ROOT,
  });
  const path = process.env.MBOX ?? "/agents/ts-a2a/chat-with-me";
  const body = process.env.MSG ?? "hello from ts";
  const agent = process.env.AGENT ?? "ts-probe"; // the sk- key's subject → stamped `from`
  try {
    await mbox.mkstream(path);
    console.log("mkstream ok:", path);
    // Forge `from` — the kernel must overwrite it with the authenticated agent_id.
    const offset = await mbox.send(path, { to: "peer", body, from: "impostor" });
    console.log("sent offset:", offset);
    const raw = await mbox.collect(path);
    console.log("collect:", raw);
    const env = JSON.parse(raw); // fresh stream → exactly one stamped envelope
    const ok = env.from === agent && env.body === body;
    if (!ok) {
      console.error(
        `FAIL: expected {from:${agent}, body:${JSON.stringify(body)}}, got ${JSON.stringify(env)}`,
      );
      process.exitCode = 1;
    } else {
      console.log(`ROUND-TRIP OK — from-stamp overwrote "impostor" -> "${env.from}" (unforgeable)`);
    }
  } finally {
    mbox.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message ?? e);
  process.exitCode = 1;
});
