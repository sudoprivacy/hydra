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
   - Emit notification lifecycle events such as `notification.created`,
     `notification.read`, and `notification.cleared`.
   - Redact text payloads in events; keep full notification text only in the
     local notification store.

3. **VS Code notification service**
   - Load notification snapshots in the extension host.
   - Watch or poll the store/event log.
   - Expose unread counts and latest notifications to existing providers.

4. **Attention Inbox**
   - Add a user-facing notification surface in VS Code.
   - Support unread-first navigation, mark-read, clear, and open-session actions.
   - Only after this exists should paste-to-copilot become optional by default.

5. **AgentRegistry (#230)**
   - Consolidate launch, resume, hook, stdout-contract, and session-capture
     behavior per supported agent.
   - Keep depth over breadth: Claude, Codex, Gemini, Sudo Code, and custom.

6. **Agent lifecycle (#233)**
   - Track `running`, `idle`, `needs-input`, `error`, `blocked`, and `unknown`.
   - Feed lifecycle changes from worker creation, hooks, notification events, and
     stop/delete paths.

7. **Agent session index (#234)**
   - Persist the mapping between Hydra sessions, native agent sessions, transcript
     files, workdirs, and last lifecycle state.
   - Use it to make `notify open` and future restore/reopen flows precise.

8. **Project policy (#236)**
   - Add trusted project-level policy only after notifications, events, and UI
     consumers exist.
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
