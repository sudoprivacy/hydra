# a2a-mailbox — PoC increment 1

A minimal **TypeScript/Node client for the nexus A2A substrate**. It proves hydra
(TS) can participate in agent-to-agent messaging end to end, over the loopback
**agent plane** (the `sk-`-token VFS bind), with no Rust/hydra glue — just the VFS
gRPC contract loaded dynamically from `nexus-vfs/proto`.

It is the TS twin of the Rust `mailbox_cli` example and the core capability the
future switchable messaging backend wraps (see the hydra A2A mapping doc §5:
`MultiplexerBackendCore.sendMessage` → `send()`, worker→copilot attention →
`send()` + a watch on the copilot's mailbox).

This is the client half of the "two synchronized switchable planes" (doc §5):

- `mailbox.mjs` — the **message plane** (increment 1).
- `tracking.mjs` — the **orchestration-tracking plane** (increment 2, slice 1).

## What `mailbox.mjs` demonstrates (message plane)

- **mkstream / send / collect** on a federated `/agents/{name}/chat-with-me`
  DT_STREAM via `Setattr` / `StreamWriteNowait` / `StreamCollectAll`.
- **Unforgeable `from`**: the client sends `{from:"impostor", to, body}`; the kernel
  stamp hook (`nexus-vfs/rust/a2a`) rewrites `from` to the caller's authenticated
  `agent_id`. `collect` returns `{"from":"ts-probe",...}` — the forged value is gone.

## What `tracking.mjs` demonstrates (orchestration-tracking plane)

- **register / list / heartbeat / unregister** a run into the kernel `AgentRegistry`,
  all over the generic `Call(method, JSON) → CallResponse` RPC — the nexus tracking
  backend hydra swaps in beside tmux-session tracking (register-don't-spawn; process
  ownership stays hydra).
- **pid IS the OS host_pid** (nexus-vfs #195): register with `host_pid=4242, local_id=7`
  and the descriptor's `pid` comes back `"4242.7"` — no separate `host_pid` field. For
  hydra this is the tmux pane pid, so `/proc/{pid}` / `ps` / `kill` line up.
  **Requires a nexus binary built at #195 (`b24e10b76`) or later** — a pre-#195 daemon
  returns the connection_id as the pid and a stale `external_info.host_pid`.

## Run it (live, against a local nexus)

1. **Mint an agent key** into a fresh data dir (nexus-vfs repo):

   ```bash
   MSYS_NO_PATHCONV=1 NEXUS_API_KEY_SECRET=poc-secret \
     ./target/debug/nexusd-cluster.exe auth mint \
     --subject-id ts-probe --subject-type agent --zone sharedzone:rw \
     --data-dir 'C:\Users\songym\nexus-poc\data'
   # prints: sk-...  (copy it)
   ```

2. **Boot a single-node founder** with the loopback agent plane (same secret):

   ```bash
   MSYS_NO_PATHCONV=1 \
     NEXUS_DATA_DIR='C:\Users\songym\nexus-poc\data' \
     NEXUS_IDENTITY_DIR='C:\Users\songym\nexus-poc\id' \
     NEXUS_API_KEY_SECRET=poc-secret NEXUS_INSECURE_NO_AUTH=true NEXUS_NO_TLS=true \
     NEXUS_ADVERTISE_ADDR=127.0.0.1:2126 \
     NEXUS_CLUSTER_INIT=sharedzone NEXUS_CLUSTER_INIT_MOUNTS=/agents=sharedzone \
     ./target/debug/nexusd-cluster.exe --agent-bind-addr 127.0.0.1:2129
   ```

   (`--agent-bind-addr` *requires* `NEXUS_API_KEY_SECRET` — the token plane stamps
   `from`, so it is never unauthenticated even under `--insecure-no-auth`.)

3. **Run the clients** (this repo):

   ```bash
   npm install

   # message plane
   MSYS_NO_PATHCONV=1 SK=sk-... node mailbox.mjs
   # mkstream ok: /agents/ts-a2a/chat-with-me
   # ROUND-TRIP OK — from-stamp overwrote "impostor" -> "ts-probe" (unforgeable)

   # orchestration-tracking plane
   SK=sk-... HOST_PID=4242 LOCAL_ID=7 NAME=pocnode-hydra-w1 node tracking.mjs
   # registered: { pid: '4242.7', name: 'pocnode-hydra-w1', state: 'REGISTERED', ... }
   # TRACKING ROUND-TRIP OK — pid == host_pid (4242.7); register/list/heartbeat/unregister all live
   ```

   `MSYS_NO_PATHCONV=1` is mandatory on Git-Bash for `mailbox.mjs`: without it the
   leading `/agents` env value is rewritten to a Windows path and the mailbox lands off
   the mount. (`tracking.mjs` takes no path arg, so it is unaffected.)

Env knobs: `ADDR` (default `127.0.0.1:2129`), `SK`, `PROTO_ROOT` (nexus-vfs `proto/`
dir) — shared; `MBOX`, `MSG`, `AGENT` (mailbox); `HOST_PID`, `LOCAL_ID`, `NAME`, `CONN`
(tracking).

## Next (increment 2, slice 2 — wire into hydra)

Both plane clients are validated live; the remaining work integrates them behind
hydra's backend seam (doc §5):

- Vendor these clients + `vfs.proto` into a hydra package; add the grpc deps to it.
- A `RunTracker` (tracking) + `MessageTransport` (message) seam with `Legacy | nexus |
  Dual` impls, chosen by **one synchronized switch** at the CLI composition roots
  (where `new TmuxBackendCore()` is), never split.
- Wire tracking into the worker/copilot lifecycle (Dual is trivially safe — nexus
  tracking is pure-additive reporting); route `sendMessage` + worker→copilot attention
  through the message transport.
- Multi-message frame delimiting (the stamp hook re-serializes each envelope, so this
  spike decodes single-message streams only); worker→copilot delivery via `sys_watch`,
  itself switchable (mailbox→tmux-inject bridge ↔ agent-reads-mailbox-via-mount).
