---
name: test-hydra
description: Use when you need to test the Hydra extension. Compiles and launches a VS Code Extension Development Host so the user can manually test the extension.
---

# Skill: test-hydra

Launch the Hydra VS Code extension in a Development Host for manual testing.

## Prerequisites

- Must be run from the repo root or a worktree of the hydra repo.
- Requires **Node.js 18+**, **VS Code** (`code` CLI on PATH), and dependencies installed (`npm install`).

## Steps

1. **Compile the extension**

   Resolve the absolute path to the repo or worktree first, then compile from that directory:

   ```bash
   cd <absolute-path-to-repo-or-worktree>
   npm run compile
   ```

   If compilation fails, report the errors and stop.

2. **Create a unique test workspace**

   Use a timestamp to avoid conflicts with other test sessions:

   ```bash
   mkdir -p /tmp/hydra-test-$(date +%s)
   ```

3. **Launch the Extension Development Host**

   ```bash
   npm run e2e:isolated -- --keep -- code --disable-extensions --extensionDevelopmentPath="<absolute-path-to-repo-or-worktree>/packages/extension" /tmp/hydra-test-<timestamp>
   ```

   This opens a new VS Code window with the locally-compiled Hydra extension loaded inside an isolated Hydra environment. Installed user extensions are disabled so their activation failures cannot obscure Hydra validation. The isolated runner also provides a private VS Code user-data directory so temporary test workspaces open without the workspace trust prompt.

4. **Inform the user**

   Tell the user the Extension Development Host is running and they can test the extension in the new VS Code window.

## Notes

- Each invocation creates a fresh test workspace under `/tmp/hydra-test-<timestamp>` to avoid conflicts.
- Only run this skill from the repo root or a worktree of the hydra repo.
- `npm run e2e:isolated -- --root <path> -- hydra ...` runs headless in isolated tmux with no VS Code window.
- `npm run e2e:isolated -- --keep -- code ...` opens a visible isolated Extension Development Host window.
