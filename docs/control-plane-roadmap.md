# Hydra Control Plane Roadmap

This roadmap records the order for building cmux-inspired control-plane
capabilities in Hydra without turning Hydra into a terminal/runtime app.

## Core Judgment

Hydra should first convert worker signals from terminal input into structured
data. Later layers should consume that data instead of scraping panes or
injecting messages.

## Stable Sequence

1. **Structured notifications (#231)**
   - Add `hydra notify create/list/read/clear/open`.
   - Store notifications in `HYDRA_HOME/notifications.json`.
   - Dual-write worker completion hooks to the store and the existing copilot
     paste path.
   - Keep the paste path for compatibility until a UI-backed inbox exists.

2. **Event log (#232)**
   - Add `HYDRA_HOME/events.jsonl`.
   - Add `hydra events --json`, `--after`, `--follow`, and `--cursor-file`.
   - Emit notification lifecycle events and the main worker/copilot lifecycle
     events needed by future extension and dashboard consumers.
   - Redact text payloads in events; keep full notification text only in the
     local notification store.
   - Defer event-log rotation until consumers are stable.

3. **VS Code notification service**
   - Load notification snapshots in the extension host via
     `NotificationStateService`.
   - Treat `notifications.json` as the authoritative state source and
     `events.jsonl` as a wake-up signal.
   - Expose unread counts, latest notifications, and session/id lookups for
     future providers and inbox UI.

4. **Attention Inbox**
   - Add a user-facing notification surface in VS Code.
   - Build it as a pure projection over `NotificationStateService` snapshots;
     opening the view must not mutate `notifications.json`.
   - Support unread-first navigation, mark-read, clear-read, and open-session
     actions. Use explicit commands for every write.
   - Keep this smaller than cmux Feed: no approve/deny flow, blocking hook wait,
     daemon, socket, or desktop notification in the first inbox version.
   - Only after this exists should paste-to-copilot become optional by default.

5. **AgentRegistry (#230)**
   - Consolidate launch, resume, hook, stdout-contract, and session-capture
     behavior per supported agent.
   - Keep depth over breadth: Claude, Codex, Gemini, Sudo Code, and custom.

6. **Agent lifecycle (#233)**
   - Track `unknown`, `starting`, `running`, `idle`, `needs-input`, `approving`,
     `blocked`, `error`, and `stopped`.
   - Keep the stored runtime snapshot separate from the visible projection used
     by CLI, session index, and UI consumers.
   - Treat `starting` and `approving` as reserved states until Feed and approval
     producers can attach request identity, timeout, and resolution semantics.
   - Feed lifecycle changes from worker creation, hooks, notification events, and
     explicit stop/delete paths.
   - Defer durable approval Feed, live event streaming, and daemon/socket APIs to
     later control-plane layers.

7. **Agent session index (#234)**
   - Persist the mapping between Hydra sessions, native agent sessions, transcript
     files, workdirs, and last lifecycle state.
   - Use it to make `notify open` and future restore/reopen flows precise.

8. **Project policy (#236)**
   - Add a safe data-only `.hydra/config.json` MVP before executable project
     automation.
   - Borrow rmux's explicit effective-config shape: `worker create` resolves
     CLI, project, global, and fallback values with source metadata.
   - Borrow cmux's trust boundary, not its action executor: project-defined
     `notifications.hooks` are reported by `config doctor` as requiring trust
     but are not executed and do not write a trust store in this version.
   - Apply only pure worker defaults now: `defaultAgent`, `baseBranch`, and
     `worker.notifyCopilot`.
   - Keep `worker.allowTaskWorkers` as a diagnostic preview until CLI and VS
     Code task-worker creation can enforce the same rule.
   - Keep notification body storage, paste compatibility, and routing policy
     explicit and previewable.

9. **Grouping and scale UX (#237)**
   - Group workers and notifications by copilot, repo, task folder, epic, or
     proposal.
   - Sort by unread and needs-input state.

## Current Non-Goals

- Native terminal replacement.
- Desktop notifications.
- Browser/cloud/mobile runtime.
- Full approval Feed.
- Broad 15+ agent integration catalog.
