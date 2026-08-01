# Cross-machine hydra over nexus A2A — acceptance runbook (task #35)

Goal: run hydra across **Win (this box) + macOS (same-LAN peer)** with copilot↔worker
messaging riding nexus A2A. Topology (start): **copilot on Win, workers on both**; each
machine runs a hydra instance on the SAME nexus cluster. Orchestration (spawn/tmux) is
LOCAL per machine; only messaging/tracking cross machines (over nexus).

## What is already done + verified (single machine)

The hydra↔nexus transport substrate is code-complete on `feat/nexus-a2a-transport` (#331),
switched by `HYDRA_TRANSPORT=legacy|nexus|dual`, and validated by live smokes against a
local founder (`packages/core`, run by hand — see `README.md`):

| smoke | proves |
|---|---|
| `smoke:nexus-tracking(-wiring)` | run register/unregister into AgentRegistry; pid == host_pid |
| `smoke:nexus-message` | mailbox send/collect + unforgeable kernel `from`-stamp |
| `smoke:nexus-watch` | `sys_watch` tail receive |
| `smoke:nexus-bridge` | copilot→worker delivery: mailbox → tmux-pane inject |
| `smoke:nexus-multi` | N messages decode in order (watch + collect) |
| `smoke:nexus-fanout` | one write reaches N watchers (DT_STREAM fan-out; broadcast basis) |

## Prerequisites

- Both machines on the overlay (Tailscale/Headscale); the federated `/agents` mount
  Win↔Mac is already validated (see federation runbook).
- **tmux/psmux** on each machine (hydra spawns workers in it): mac = `tmux`, win =
  `winget install psmux`. Required even with nexus messaging — nexus does NOT spawn
  processes yet (that's task #36, ManagedAgentService v2).
- A nexus daemon per machine, joined into ONE cluster with `/agents` federated.
- Agent auth: **auth-off first** (sk- loopback token, pre-#194 daemon) for the initial
  run; **auth-on** (mTLS + cert bundle) once nexus-vfs #194 ships downstream (peer's
  hydra #332 handles the vfsClient connection half).

## Setup

**1. nexus cluster (Win founder + Mac joiner), `/agents` federated** — per the federation
runbook. Win founder advertises its overlay IP; Mac joins with the join token; both mount
`/agents=sharedzone`. Confirm cross-machine `/agents` byte-exact (readdir/stat) before
proceeding.

**2. Mint one agent key per hydra identity** (auth-on) OR use the loopback sk- plane
(auth-off) — `nexusd-cluster auth mint --subject-type agent --subject-id <name>
--zone sharedzone:rw`. Names must be cluster-unique across machines (until §F auto-naming,
name them distinctly, e.g. `win-copilot`, `mac-w1`).

**3. hydra per machine, nexus transport on:**
```
export HYDRA_TRANSPORT=nexus            # or dual during migration
export NEXUS_AGENT_ADDR=127.0.0.1:2129  # that machine's local agent plane (auth-off)
export NEXUS_SK=sk-...                  # that machine's minted key
# (auth-on: the cert bundle path instead, per hydra #332)
```
Start the hydra sidecar/CLI on each machine with those set. The sidecar composition root
(`appService.ts`) builds both planes from `createTransport({ backend })`.

## The run

1. **Mac**: `hydra worker create --repo <r> --branch <b>` → spawns `mac-w1` locally (tmux).
   Its run registers into nexus (`agent_list` shows it); its inbound bridge tails
   `/agents/mac-w1/chat-with-me`.
2. **Win**: copilot sends a task to `mac-w1` → `messageTransport.send("mac-w1", …)` writes
   the federated mailbox → replicates to Mac → Mac's bridge injects it into `mac-w1`'s pane.
3. **Verify**: the task text appears in `mac-w1`'s agent (cross-machine copilot→worker over
   nexus, no tmux link between machines). Also do a local Win worker for the mixed topology.

## Known gaps to close before/around the run

- **worker→copilot attention** (reverse direction): the worker signalling the copilot still
  rides `NotificationStore`; rerouting it through the mailbox + a copilot-side bridge is the
  remaining message-plane piece (copilot lifecycle is in `SessionManager`/CLI, not WLS).
- **§F naming**: until it lands, name agents distinctly per machine by hand.
- **auth-on connect**: the mTLS+cert bundle path is hydra #332 (peer), held to the
  nexus-vfs release.
- **Cross-machine SPAWN** (copilot-Win spawns worker-Mac): NOT this milestone — that's the
  control plane (task #36, ManagedAgentService v2). Here workers are spawned locally.
