// PoC increment 2, slice 1 — TS nexus orchestration-tracking client.
//
// The second of the "two synchronized switchable planes" (doc §5): a run's
// identity / lifecycle. Legacy backend = tmux-session tracking; nexus backend =
// register_external / heartbeat into the kernel AgentRegistry (+ /proc/{pid}).
// Process OWNERSHIP (spawn/kill/git/worktree) stays hydra either way — this only
// *reports the run in* (register-don't-spawn); the tmux/OS process is untouched.
//
// All ops ride the generic Call RPC (method + JSON params) on NexusVFSService, over
// the same loopback agent plane as the mailbox client.
//
//   SK=sk-... node tracking.mjs   # register -> list -> heartbeat -> unregister round-trip

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

/** Reports hydra runs (worker/copilot) into the nexus kernel AgentRegistry. */
export class NexusTracking {
  constructor({ address = "127.0.0.1:2129", token = "", protoRoot } = {}) {
    this.token = token;
    const root = protoRoot ?? "C:/Users/songym/cursor-projects/nexus-vfs/proto";
    const def = protoLoader.loadSync("nexus/grpc/vfs/vfs.proto", {
      keepCase: true,
      longs: String,
      defaults: true,
      includeDirs: [root],
    });
    const pkg = grpc.loadPackageDefinition(def);
    this.client = new pkg.nexus.grpc.vfs.NexusVFSService(
      address,
      grpc.credentials.createInsecure(),
    );
  }

  /** One kernel Call: method + JSON params -> parsed JSON result (throws on is_error). */
  #call(method, params) {
    return new Promise((resolve, reject) => {
      this.client.Call(
        { method, payload: Buffer.from(JSON.stringify(params)), auth_token: this.token },
        (err, res) => {
          if (err) return reject(err);
          if (process.env.DEBUG)
            console.error(
              `[call] ${method} is_error=${res.is_error} payload=${res.payload && res.payload.length ? Buffer.from(res.payload).toString() : "<empty>"}`,
            );
          const body =
            res.payload && res.payload.length
              ? JSON.parse(Buffer.from(res.payload).toString())
              : null;
          if (res.is_error) return reject(new Error(`${method}: ${JSON.stringify(body)}`));
          // Call rpc_codec wraps success values as {"result": <value>}.
          resolve(body && typeof body === "object" && "result" in body ? body.result : body);
        },
      );
    });
  }

  /**
   * Report a run in as an UNMANAGED external agent. `hostPid` is the OS pid of the
   * process hosting the agent (for hydra: the tmux pane pid); the kernel encodes the
   * agent pid = `${hostPid}[.${localId}]` (nexus-vfs #195 — the pid IS the OS pid).
   * Returns the AgentDescriptor (`pid`, `name`, `state`, `last_heartbeat_ms`, …).
   */
  registerRun({
    name,
    hostPid,
    connectionId,
    ownerId = "hydra",
    zoneId = "sharedzone",
    localId,
    protocol = "hydra",
    labels = {},
  }) {
    return this.#call("agent_register_external", {
      name,
      owner_id: ownerId,
      zone_id: zoneId,
      connection_id: connectionId,
      host_pid: hostPid,
      local_id: localId,
      protocol,
      labels,
    });
  }

  heartbeat(pid) {
    return this.#call("agent_heartbeat", { pid });
  }

  list(filter = {}) {
    return this.#call("agent_list", {
      zone_id: filter.zoneId,
      owner_id: filter.ownerId,
      kind: filter.kind,
      state: filter.state,
    });
  }

  unregister(pid) {
    return this.#call("agent_unregister_external", { pid });
  }

  close() {
    this.client.close();
  }
}

async function main() {
  const t = new NexusTracking({
    address: process.env.ADDR ?? "127.0.0.1:2129",
    token: process.env.SK ?? "",
    protoRoot: process.env.PROTO_ROOT,
  });
  const name = process.env.NAME ?? "pocnode-hydra-w1";
  const hostPid = Number(process.env.HOST_PID ?? 4242);
  const connectionId = process.env.CONN ?? "hydra-conn-1";
  const localId = process.env.LOCAL_ID ? Number(process.env.LOCAL_ID) : undefined;
  const expectedPid = localId != null ? `${hostPid}.${localId}` : String(hostPid);
  try {
    const desc = await t.registerRun({ name, hostPid, connectionId, localId });
    console.log("registered:", { pid: desc.pid, name: desc.name, state: desc.state, kind: desc.kind });
    if (desc.pid !== expectedPid)
      throw new Error(`pid ${desc.pid} != expected ${expectedPid} (host_pid encoding, #195)`);
    if (desc.name !== name) throw new Error(`name ${desc.name} != ${name}`);

    const before = await t.list();
    if (!before.some((a) => a.pid === desc.pid && a.name === name))
      throw new Error("run not in agent_list after register");
    console.log(`list: ${before.length} agent(s), ours present`);

    const hb = await t.heartbeat(desc.pid);
    console.log("heartbeat: last_heartbeat_ms =", hb.last_heartbeat_ms);
    if (hb.last_heartbeat_ms == null) throw new Error("heartbeat did not stamp last_heartbeat_ms");

    await t.unregister(desc.pid);
    const after = await t.list();
    if (after.some((a) => a.pid === desc.pid)) throw new Error("run still present after unregister");
    console.log("unregister ok — run gone from agent_list");

    console.log(
      `TRACKING ROUND-TRIP OK — pid == host_pid (${desc.pid}); register/list/heartbeat/unregister all live`,
    );
  } finally {
    t.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message ?? e);
  process.exitCode = 1;
});
