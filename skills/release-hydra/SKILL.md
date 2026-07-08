---
name: release-hydra
description: Use when releasing a new version of Hydra. Bumps version, generates changelog, and creates a release PR.
---

# Skill: release-hydra

Release a new version of the Hydra VS Code extension by creating a release PR.

## Prerequisites

- Must be run from a branch off `main` (e.g., `release/<version>`), NOT directly on `main`.
- If not already on a release branch, create one first: `git checkout -b release/<version>`

## Steps

1. **Determine the next version**

   Format: `0.<minor>.<yyyymmddNN>` (UTC date + 2-digit in-day counter).

   - Patch: today's `yyyymmdd` + `NN` — `00` for the first release of the day, else increment from the current patch's `NN`.
   - Minor: bump only on schema/breaking changes (resets `NN` to `00`). The `0.3.x` line is the first on this scheme.

2. **Collect commits since last release**

   Find the last release tag:

   ```bash
   git tag --sort=-creatordate | head -1
   ```

   Then get all commits between that tag and HEAD on `main`, excluding release commits:

   ```bash
   git log --oneline <last-tag>..HEAD --no-merges | grep -v 'chore: release'
   ```

3. **Generate high-level changelog entry**

   Write a concise changelog entry under `## [<version>] - <date>`. Keep it high-level:
   - Summarize changes into categories: Added, Changed, Fixed, Removed
   - Use conventional commit prefixes to classify: `feat:` → Added, `fix:` → Fixed, `revert:` → Removed, everything else → Changed
   - One bullet per logical change (collapse related commits into a single bullet)
   - Do NOT include a per-commit list — keep it brief and user-facing

   Prepend the new section to `CHANGELOG.md` after the `# Changelog` header.

4. **Bump the version (single source of truth = root `package.json`)**

   Set the new version string **only** in the root `package.json` (`"version"` field),
   then propagate it to every workspace manifest and the lockfile:

   ```bash
   npm run sync-version
   ```

   `sync-version` writes the root version into `packages/core/package.json`,
   `packages/cli/package.json`, `packages/extension/package.json`, and
   `package-lock.json` (root `version`, `packages[""].version`, and each
   `packages/<pkg>` entry). This keeps the git tag (from root, via
   `auto-tag-release.yml`) equal to the published version (the .vsix is built from
   `packages/extension/package.json`, the CLI/telemetry versions come from the
   `@hydra/*` manifests).

   Do **not** hand-edit the workspace manifests. The `smoke:version-consistency`
   test (run as part of `npm test`) fails closed if any of the four manifests
   diverge, and `scripts/package-vsix.js` refuses to build a .vsix whose version
   disagrees with the root.

5. **Commit and create release PR**

   ```bash
   git add package.json package-lock.json packages/*/package.json CHANGELOG.md
   git commit -m "chore: release v<version>"
   git push -u origin HEAD
   ```

   Then create a PR targeting `main`:

   ```bash
   gh pr create --title "chore: release v<version>" --body "Release v<version>" --base main
   ```

   When the PR is merged, the `auto-tag-release.yml` workflow detects the version bump in `package.json` and automatically creates + pushes the `v<version>` tag, which in turn triggers the publish workflow.

## Notes

- **Do NOT create or push tags manually.** The `auto-tag-release.yml` workflow handles tagging automatically when the version bump lands on `main`.
- The publish workflow (`.github/workflows/publish.yml`) triggers on `v*` tags and handles: VSIX packaging, Marketplace/Open VSX publishing, and GitHub Release creation.
- Full release pipeline: PR merged → auto-tag detects version bump → creates `v<version>` tag → publish workflow runs.
- Only run this skill from the repo root or a worktree of the hydra repo.
