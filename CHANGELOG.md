# Changelog

## [0.3.2026060501] - 2026-06-05

### Changed
- Use a clearer add icon for the Create Copilot sidebar action

### Fixed
- Improve Windows command execution by decoding console output with the active code page and avoiding Unix-only environment wrappers when launching tmux/psmux
- Install worker completion hooks even when workers are created without a task prompt

## [0.3.2026060500] - 2026-06-05

### Added
- Show managed workers and repositories directly on Copilot tree items so orchestrator state is easier to scan in the sidebar

## [0.3.2026060401] - 2026-06-04

### Added
- Add Hydra diagnostic logging across CLI and VS Code, including JSONL log files with rotation/redaction, log discovery commands, doctor output, and session lifecycle diagnostics

### Fixed
- Avoid a VSIX package secret-scan false positive in the logging smoke test so the extension publish workflow can complete

## [0.3.2026060400] - 2026-06-04

### Added
- Add Hydra diagnostic logging across CLI and VS Code, including JSONL log files with rotation/redaction, log discovery commands, doctor output, and session lifecycle diagnostics

### Changed
- Clarify that a Hydra copilot is a cross-repo orchestrator rather than a per-repo worker

## [0.3.2026060300] - 2026-06-03

### Fixed
- Treat silent psmux `has-session` failures as missing sessions so Hydra can recover cleanly when checking tmux session state

## [0.3.2026060100] - 2026-06-01

### Added
- Add first-class Task Workers for folder-based AI work without a git repo, including CLI create/delete flows, VS Code create-worker UX, Local Tasks sidebar grouping, archive restore, docs, and smoke/e2e coverage

## [0.3.2026052800] - 2026-05-28

### Added
- Add configurable default agent support across CLI config, copilot/worker creation, global config, docs, and smoke coverage

### Changed
- Update repository references from `joezhoujinjing/hydra` to `sudoprivacy/hydra`

### Fixed
- Refresh the sidebar promptly after external worker creation updates session state
- Detect copilot identity from process environment for CLI commands running inside copilot sessions
- Clarify the missing tmux install prompt on macOS and Linux

## [0.3.2026052700] - 2026-05-27

### Fixed
- Persist and resume copilot sessions across tmux restarts

## [0.3.2026052600] - 2026-05-26

### Changed
- Improve planner copilot entry UX with clearer create/start behavior and sidebar presentation
- Replace the Activity Bar icon with a simplified abstract Hydra glyph optimized for small VS Code sidebar rendering

### Fixed
- Keep worker and copilot sidebar selection highlighted when switching terminal tabs, including workers inside collapsed repo groups
- Fix agent completion hook startup prompts

## [0.3.2026052500] - 2026-05-25

### Added
- Add plan copilot mode for Claude and Codex, including guarded launch/resume behavior, CLI and VS Code entry points, persisted session mode, sidebar labels, and plan-specific onboarding

## [0.3.2026052201] - 2026-05-22

### Fixed
- Fix sidebar loading sweep loop caused by synchronous writes

## [0.3.2026052200] - 2026-05-22

### Added
- Add README demo GIF to show the Hydra workflow

### Fixed
- Fix Hydra worker review and context-menu session resolution after editor tabs are closed or VS Code omits the tree item argument

## [0.3.2026052000] - 2026-05-20

### Fixed
- Make Hydra sidebar actions resilient when VS Code does not pass a tree item argument, including Review Changes and Remove session flows

## [0.3.2026051800] - 2026-05-18

### Added
- Add Sudo Code as a first-class Hydra agent for copilots and workers, including configurable launch commands, resume, archive/restore, CLI visibility, and smoke/e2e coverage

## [0.3.2026051302] - 2026-05-13

### Fixed
- Fix native worker share acceptance when the sender's worker worktree folder name differs from the receiver's repo clone path

## [0.3.2026051301] - 2026-05-13

### Changed
- Improve native session sharing ergonomics with default share storage config, shorter public share commands, and clearer received copilot names

## [0.3.2026051300] - 2026-05-13

### Added
- Native Codex session sharing for Hydra copilots and workers, with local bundle, GCS, and public HTTPS accept flows

### Changed
- Refresh the Hydra sidebar when session state changes

## [0.3.2026051000] - 2026-05-10

### Changed
- Open worker review changes in a dedicated maximized editor group for a clearer review flow

## [0.3.2026050801] - 2026-05-08

### Added
- Worker completion notifications via native Claude, Codex, and Gemini hooks, with per-message arming so direct worker chats do not notify the copilot
- Worker change review action and review-focused diff UX in the Hydra sidebar

### Fixed
- Harden completion hook configuration and notification delivery across supported agents

## [0.3.2026050800] - 2026-05-08

### Added
- Telemetry framework with swappable backend and default PostHog transport (#133, #137)
- Repo registry CLI with auto-fetch wiring (#135)
- Surface session ID and session file path in logs and `list` output (#132)

### Fixed
- Replace broken symlinks with NTFS junctions on Windows worktrees (#126)
- Ensure Enter is sent after message text in worker send (#122)
- Avoid shell injection in sidebar git commands
- Guard against nested worker creation
- Worker delete consistency and worker resume slug identity

## [0.3.2026050600] - 2026-05-06

### Changed
- Adopt date-based versioning: `0.<minor>.<yyyymmddNN>` (UTC date + in-day counter); minor bumps only on schema/breaking changes

## [0.2.2] - 2026-05-06

### Fixed
- Prompt Windows users to install psmux from VS Code when Hydra cannot find the session backend

## [0.2.1] - 2026-05-06

### Fixed
- Detect agent CLIs reliably on Windows
- Improve tmux mouse wheel scrolling behavior

## [0.2.0] - 2026-05-06

### Added
- Windows platform support for core helpers (#112)
- Windows CLI installer, doctor, and clipboard support (#113)
- Windows terminal and shell integration via psmux (#114)
- Windows CI smoke test job
- Copilot lifecycle CLI and hardened tmux sync (#95)
- Codex and Gemini skills symlinks (#97)
- Isolated e2e scenario runner and plumbing (#101, #103)

### Fixed
- Fix Codex copilot launch when tmux PATH cannot find codex (#109)
- Fix unresolved merge markers in session manager (#109)
- Exclude local state files from VSIX packaging (#107)
- Fail closed on worker delete tmux errors (#106)
- Reuse shared GitHub repo in e2e runner (#103)
- Support codex e2e runner isolation (#102)
- Serialize session state updates to avoid worker ID races (#102)
- Keep codex sessions in bypass mode (#100)

### Changed
- Limit `hydra whoami` to worker worktrees only (#99)
- Clarify isolated test modes in docs (#100)

## [0.1.32] - 2026-05-06

### Fixed
- Exclude local state files from VSIX packaging (#107)
- Fail closed on worker delete tmux errors instead of silently continuing (#106)

## [0.1.31] - 2026-05-06

### Added
- Add isolated Hydra end-to-end test plumbing and scenario runner support (#101, #103)

### Changed
- Add copilot lifecycle CLI support and Codex/Gemini skill symlinks (#95, #97)

### Fixed
- Serialize session state updates to avoid worker ID assignment races (#102)
- Keep Codex bypass sessions working in isolated environments and limit `hydra whoami` to worker worktrees (#99, #100)

## [0.1.30] - 2026-05-05

### Added
- Auto-reveal sidebar item when terminal tab is focused (#93)
- Store copilotSessionId in worker metadata (#83)
- `hydra whoami` CLI subcommand (#86)
- `hydra doctor` CLI subcommand (#82)
- Fetch latest from remote before creating worker/copilot (#70)

### Changed
- Route all session lifecycle through SessionManager (#91)
- Split session creation into Phase 1 and Phase 2 (#87)
- Use PAT for auto-tag to trigger publish workflow (#81)

### Fixed
- Use displayName for worker labels in sidebar (#89)
- Ensure consistent Hydra icon on all worker/copilot terminal tabs (#85)
- Poll for agent readiness before sending task prompt (#80)

## [0.1.29] - 2026-05-05

### Added
- Archive deleted sessions to `~/.hydra/archive.json` (#73)
- `displayName` field for cleaner session name display (#77)
- Display worker numbers in CLI list output (#74)
- Open shell via tmux split-window instead of VS Code terminal (#71)
- Test-hydra skill for launching Extension Development Host (#69)

### Changed
- Move worktree location outside the repo to `~/.hydra/worktrees/` (#72)
- Remove Create Worker button from sidebar UI (#68)
- Remove dead COPILOT_AGENTS.md and WORKER_AGENTS.md code (#75)

### Fixed
- Remove `--add-dir` flag from worker agent launch commands (#76)

## [0.1.28] - 2026-05-05

### Added
- Release-hydra skill for automated version releases (#62)

### Fixed
- Replace retired shields.io badges with vsmarketplacebadges.dev (#63)

### Changed
- Add auto-tag CI workflow on version bump (#64)

## [0.1.27] - 2026-05-04

### Added
- feat: clean up right-click context menu in sidebar panels (#59)

### Commits
1. 2afab65 feat: clean up right-click context menu in sidebar panels (#59)

## [0.1.26] - 2026-05-04

### Added
- feat: capture agent session ID at copilot/worker creation time (#43) (#58)

### Commits
1. c4242b9 feat: capture agent session ID at copilot/worker creation time (#43) (#58)

## [0.1.25] - 2026-05-04

### Changed
- docs: rebrand README with "Hydra" metaphor and parallel workflow vision (#54)

### Commits
1. 2d2d577 docs: rebrand README with "Hydra" metaphor and parallel workflow vision (#54)

## [0.1.24] - 2026-05-04

### Added
- feat: show PR status alongside git changes in tree view (#53)

### Commits
1. ced03cf feat: show PR status alongside git changes in tree view (#53)

## [0.1.23] - 2026-05-04

### Added
- feat: add release notes system with CHANGELOG.md and publish integration (#52)

### Commits
1. 38efd1a feat: add release notes system with CHANGELOG.md and publish integration (#52)

## [0.1.21] - 2026-05-04

### Changed
- chore: restructure CLAUDE.md and AGENTS.md — single source of truth (#49)
- chore: clean up launch.json — remove legacy Go CLI entries (#48)

### Commits
1. 4e8b4ff chore: restructure CLAUDE.md and AGENTS.md — single source of truth (#49)
2. b997b0c chore: clean up launch.json — remove legacy Go CLI entries (#48)

## [0.1.20] - 2026-05-03

### Added
- feat: add rename command for copilots and workers (#42)

### Commits
1. 6e0b5a0 feat: add rename command for copilots and workers (#42)

## [0.1.19] - 2026-05-03

### Added
- feat: separate editor groups for copilots and workers (#36)

### Commits
1. 8102c78 feat: separate editor groups for copilots and workers (#36)

## [0.1.18] - 2026-05-03

### Changed
- test: use --dangerously-skip-permissions instead of --allowedTools
- test: try claude-opus-4-6[1m] model suffix
- Add Claude Code GitHub Workflow (#37)

### Fixed
- fix: align Claude workflow config with working pattern

### Commits
1. ed928c7 test: use --dangerously-skip-permissions instead of --allowedTools
2. 4b9e831 test: try claude-opus-4-6[1m] model suffix
3. d3a729c fix: align Claude workflow config with working pattern
4. 9475378 Add Claude Code GitHub Workflow (#37)

## [0.1.17] - 2026-05-03

### Changed
- chore: remove Zellij backend entirely (#33) (#35)

### Commits
1. 24e73ca chore: remove Zellij backend entirely (#33) (#35)

## [0.1.16] - 2026-05-03

### Fixed
- fix: send Enter separately after message paste to avoid bracketed paste absorption (#31) (#32)

### Commits
1. 7a39a53 fix: send Enter separately after message paste to avoid bracketed paste absorption (#31) (#32)

## [0.1.15] - 2026-05-03

### Added
- feat: add copilot preflight CLI verification (#30)

### Commits
1. d6218ab feat: add copilot preflight CLI verification (#30)

## [0.1.13] - 2026-05-03

### Added
- feat(cli): worker logs, send commands + CLI install (#29)

### Commits
1. 4dc323a feat(cli): worker logs, send commands + CLI install (#29)

## [0.1.12] - 2026-05-03

### Added
- feat: CLI install & update mechanism (#28)

### Commits
1. e5961c2 feat: CLI install & update mechanism (#28)

## [0.1.11] - 2026-05-03

### Added
- feat(cli): stable sorting and status legend for list command (#26)

### Fixed
- fix: add missing hydra activity bar icon SVG

### Commits
1. 4d91c45 fix: add missing hydra activity bar icon SVG
2. 8140367 feat(cli): stable sorting and status legend for list command (#26)

## [0.1.10] - 2026-05-03

### Changed
- chore: remove legacy Go CLI (#27)

### Commits
1. e450b04 chore: remove legacy Go CLI (#27)

## [0.1.9] - 2026-05-03

### Changed
- docs: revamp README and add real-world workflow examples (#25)

### Commits
1. ca7bc97 docs: revamp README and add real-world workflow examples (#25)

## [0.1.8] - 2026-05-02

### Fixed
- fix: publish workflow and Marketplace icon (#24)

### Commits
1. 1ebf6bd fix: publish workflow and Marketplace icon (#24)

## [0.1.7] - 2026-05-02

### Changed
- chore: resize SVG icons to 150x150
- chore: rename to hydra-code, bump to v0.1.3, update icons
- chore: remove completed CLI rewrite planning doc
- chore: replace hardcoded ~/code paths with ~/.hydra/repo

### Fixed
- fix: skip past existing tags in publish workflow (#23)
- fix: correct publisher to zhoujinjing for VS Code Marketplace

### Commits
1. 82771ec fix: skip past existing tags in publish workflow (#23)
2. 240fae4 fix: correct publisher to zhoujinjing for VS Code Marketplace
3. 1096378 chore: resize SVG icons to 150x150
4. 4545405 chore: rename to hydra-code, bump to v0.1.3, update icons
5. 76c8cdf chore: remove completed CLI rewrite planning doc
6. d9936c3 chore: replace hardcoded ~/code paths with ~/.hydra/repo
