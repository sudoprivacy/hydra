<p align="center">
  <img src="resources/logo.jpg" alt="Hydra" width="600" />
</p>

<h1 align="center">Hydra</h1>

<p align="center">
  <strong>Grow heads. Ship faster.</strong><br>
  Orchestrate an army of parallel AI agents directly from VS Code.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=zhoujinjing.hydra-code">
    <img src="https://vsmarketplacebadges.dev/version/zhoujinjing.hydra-code.svg" alt="Marketplace" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=zhoujinjing.hydra-code">
    <img src="https://vsmarketplacebadges.dev/installs/zhoujinjing.hydra-code.svg" alt="Installs" />
  </a>
  <a href="LICENSE.md">
    <img src="https://img.shields.io/github/license/sudoprivacy/hydra" alt="License" />
  </a>
</p>

<p align="center">
  <img src="docs/hydra-demo.gif" alt="Hydra demo showing parallel AI agents in VS Code" width="800" />
</p>

🌏 **Read this in other languages:** **English** | [中文](docs/README.zh.md)

---

## The Vision

In Greek mythology, the Hydra was a beast that grew two heads for every one cut off. In software engineering, we face a similar "beast": a mountain of tasks that grows faster than we can code.

**Hydra** turns this metaphor on its head. Instead of struggling against the growth, you embrace it. You become the central nervous system, spawning and orchestrating as many AI agent "heads" as you need. One head builds the auth, another optimizes the database, a third writes the tests — all working simultaneously, all visible from your sidebar.

**Stop working sequentially. Start working in parallel.**

---

## A Story of Parallel Power

Imagine you're porting 40 features from an old codebase. Doing it alone is a weeks-long slog. With Hydra, it looks like this:

1. **Spawn a Copilot** on your `main` branch. You tell it: "Analyze these 40 features and break them into 8 logical groups."
2. **Delegate to Workers.** With a single command, your Copilot spawns 8 Workers. Each gets its own git branch, its own isolated worktree, and its own AI agent (Claude, Gemini, or Codex).
3. **Orchestrate.** You watch your sidebar. 8 terminals are alive. 8 agents are coding. You see their CPU usage, their git diffs, and their progress in real-time.
4. **Review & Ship.** As Workers finish, you review their diffs, merge their branches, and move on.

**What took weeks now takes hours.**

```text
[ YOU: THE ARCHITECT ]
         │
         ▼
 [ COPILOT (main) ] ──────────────────┐
 (Plans, Monitors, Reviews)           │
         │                            │
         ├─> [ WORKER 1 (feat/auth) ] ─┼─> "Building OAuth2 flow..."
         ├─> [ WORKER 2 (feat/ui)   ] ─┼─> "Styling the dashboard..."
         ├─> [ WORKER 3 (fix/perf)  ] ─┼─> "Optimizing DB queries..."
         └─> [ WORKER 4 (docs/api)  ] ─┼─> "Generating OpenAPI docs..."
                                      │
                                [ THE ARMY ]
```

---

## Why Hydra?

- **The Serial Bottleneck:** Switching between tasks is expensive. Waiting for one AI agent to finish before starting the next is a waste of your most precious resource: time.
- **Context is King:** Hydra isolates agents in their own git worktrees. No more "agent halluncinations" because they saw unrelated code. No more git conflicts because two agents touched the same file in the same directory.
- **Persistent Souls:** Every agent lives in a `tmux` session. Close VS Code, restart your computer, or SSH in from your phone — your agents are still there, working for you.

---

## Quick Start (60 Seconds)

1. **Install:** Search for **"Hydra Code"** in the VS Code Marketplace.
2. **Prerequisites:** Ensure `tmux` and `git` are installed on your system.
3. **Launch Copilot:** Open the Hydra sidebar (robot icon) and click **"Create Copilot"**.
4. **Spawn your first Worker:** 
   - Click **"Create Worker"**.
   - Name your branch (e.g., `feat/my-new-idea`).
   - Choose an agent (e.g., `claude`).
   - **Watch the magic happen.**

---

## Capabilities

### 🏛️ The Command Center (Sidebar)
Your sidebar is no longer just a file explorer. It's a high-fidelity dashboard for your AI army.
- **Live Vitals:** See CPU usage, terminal activity, and pane counts for every agent.
- **Git Intelligence:** Track how many commits every worker is ahead of main, and see exactly how many files they've touched.
- **One-Click Attach:** Jump into any agent's terminal or embed it directly as an editor tab.

### 💂 The Army (Workers & Worktrees)
Hydra automates the heavy lifting of git management.
- **Isolated Worktrees:** Every worker gets a dedicated directory under `~/.hydra/worktrees/` (outside the repo). They won't mess with your primary workspace.
- **Autonomous Mode:** Workers can be launched with auto-approved permissions, letting them work while you sleep.

### 🧠 The Brain (Copilots)
A Copilot is your tech lead. It doesn't need a worktree; it lives in your current folder and uses the `hydra` CLI to manage your workers.

### 🖇️ Smart Tools
- **CLI-First:** The `hydra` command lets you (and your agents) control everything from the terminal.
- **Smart Paste:** Copy an image? `Cmd+V` in the terminal saves it and inserts the path. Perfect for showing UI bugs to your agents.

---

## Repo registry

Tired of cloning a repo by hand, writing down its absolute path, and
hoping you remembered to pull `main` before spawning a worker? Register
it once, then refer to it by its `<owner>/<name>`:

```bash
hydra repo add sudoprivacy/hydra
hydra worker create --repo sudoprivacy/hydra --branch feat/foo
```

Hydra clones the repo into `~/.hydra/repos/<owner>/<name>/` and treats
that directory as a clean mirror of `origin/main`. Every `worker create`
runs `git fetch origin` first, so workers always branch off the latest
remote — no more "I forgot to pull" drift.

```text
~/.hydra/
├── repos/
│   └── joezhoujinjing/
│       └── hydra/          ← managed clone (always clean)
└── worktrees/
    └── <repo-id>/<slug>/   ← per-worker worktree
```

### Commands

```bash
hydra repo add <identifier>     # sudoprivacy/hydra | https://github.com/... | git@github.com:...
hydra repo list                 # show registered repos and last-fetched time
hydra repo fetch <owner/name>   # git fetch origin in the managed clone
hydra repo fetch --all          # refresh every registered repo
hydra repo remove <owner/name>  # delete the clone (refuses if worktrees exist; --force to bypass)
```

### Backward compatibility

`--repo <abs-path>` still works exactly as before. Use the registry for
new repos and keep your existing dev clones untouched:

```bash
hydra worker create --repo /Users/me/code/legacy --branch fix/x   # still fine
```

The registry is currently GitHub-only (https + ssh URLs and the short
`<owner>/<name>` form). PR B will move worker worktrees under the
managed clone (`~/.hydra/worktrees/<owner>/<name>/<slug>/`); for now
they continue to live at the existing path. See [DESIGN.md](DESIGN.md)
for the full design and open questions.

## Reference & Documentation

- [**AGENTS.md**](AGENTS.md) — The full "Agent Operating Manual" (CLI reference, internal architecture, and advanced config).
- [**Examples**](examples/) — Real-world scenarios like [Parity Ports](examples/parity-port.md) and [gRPC Generation](examples/grpc-generation.md).
- [**Changelog**](CHANGELOG.md) — See what's new in the latest version.

## Requirements
- **tmux** — The engine of persistence.
- **git** — The foundation of isolation.
- **VS Code 1.85.0+**

## Telemetry

Hydra ships with an anonymous telemetry framework so we can understand which features get used and where to invest. It is designed to collect adoption signals only — never your code, prompts, or repo metadata.

**What is collected**
- A randomly generated anonymous ID, stored in `~/.hydra/anonymous-id` (UUIDv4, regenerated by deleting the file).
- Event names for high-level lifecycle actions: `worker_created`, `worker_resumed`, `worker_deleted`, `copilot_created`, `copilot_deleted`.
- The agent type for create/resume events (`claude`, `codex`, `gemini`, `custom`).
- Hydra version, Node.js version, and `process.platform` (`darwin`, `linux`, `win32`).

**What is NOT collected**
- Repository names, paths, branch names, or remote URLs.
- Task prompts, file contents, diffs, or any code.
- Session names or session IDs.
- Hostname, username, IP, MAC address, or any other PII.

**Where events go**
- Events are sent to [PostHog Cloud (US)](https://us.i.posthog.com) via the `posthog-node` SDK. The project's ingest API key is embedded in the build — PostHog `phc_` project keys are write-only, public ingestion tokens (same security model as Mixpanel project tokens or Sentry DSNs) and are intended to ship inside distributed clients.

**Opt out**
- Set `HYDRA_TELEMETRY=0` (or `off`) in your environment. No events will be sent and no anonymous ID will be created.
- Inspect events locally with `HYDRA_TELEMETRY_DEBUG=1`, which writes JSON-line events to `~/.hydra/telemetry.log` instead of sending them anywhere. This overrides the PostHog backend and keeps every event on disk.

**Override the destination**
- `HYDRA_POSTHOG_API_KEY=<your-key>` — point Hydra at a different PostHog project (e.g. self-hosted PostHog, or a test project for verification).
- `HYDRA_POSTHOG_HOST=<https://...>` — change the ingest host (defaults to `https://us.i.posthog.com`; use `https://eu.i.posthog.com` for EU cloud or your self-hosted URL).

## License
[MIT](LICENSE.md) — Built with ❤️ for the future of AI-native development.
