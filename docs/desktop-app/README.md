# Desktop app — design

Design docs for turning Hydra from a VS Code extension into a standalone desktop app
(**Fork A now, interface B-compatible**).

- **[FINAL.md](./FINAL.md)** — ⭐ authoritative reconciled proposal. Read this. Supersedes the drafts below.
- [PROPOSAL-claude.md](./PROPOSAL-claude.md) — Claude's independent draft (provenance).
- [PROPOSAL-codex.md](./PROPOSAL-codex.md) — Codex's independent draft (provenance).

**How it was produced:** two AI teams (Claude + Codex) wrote independent proposals from one
brief (~90% convergent), cross-reviewed each other on 5 deltas, then reconciled into `FINAL.md`;
both signed off. The terminal layer is de-risked by a runnable spike (`spikes/terminal-bridge/`,
see its `FINDINGS.md`).

**One line:** Electron app + a plain forked Node sidecar that `import`s the already-headless
`src/core`; renderer is a thin loopback client via `HydraControlClient` over an injected
`HydraTransport`; graduating to a `hydrad` daemon (Fork B) is "swap the transport + add auth,"
not a rewrite. ~8–10 engineer-weeks.
