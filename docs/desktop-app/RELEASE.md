# Hydra Desktop release and in-app update

Hydra uses one release gate for the extension and the macOS Desktop app:

1. Merge normal feature PRs into `main`. This does not publish a release.
2. Create a `release/<version>` PR with the root version bump and changelog entry.
3. Merge the release PR. `auto-tag-release.yml` creates `v<version>`.
4. `publish.yml` publishes the extension, builds/signs/notarizes Desktop, and creates one GitHub Release containing every asset.
5. Packaged Desktop clients check the GitHub release feed after startup and every four hours. Users choose when to download and restart.

The GitHub Release is created only after both the extension and Desktop jobs succeed. Desktop is currently distributed for Apple Silicon (`arm64`) only.

## Required GitHub Actions secrets

Configure these repository secrets before merging the first release PR that uses the automated Desktop job:

- `MACOS_CERTIFICATE_P12`: base64-encoded PKCS#12 export of the Developer ID Application certificate and private key.
- `MACOS_CERTIFICATE_PASSWORD`: password used when exporting that PKCS#12 file.
- `APPLE_ID`: Apple Developer account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password created at `account.apple.com`.
- `APPLE_TEAM_ID`: Apple Developer team ID.

Never commit a certificate, private key, password, API key, or decoded PKCS#12 file. The workflow imports the certificate into an ephemeral keychain and removes both the keychain and temporary certificate file at the end of the job.

## Release assets

Every successful release contains:

- `hydra-<version>.vsix`
- `Hydra-<version>-arm64.dmg`
- `Hydra-<version>-arm64-mac.zip`
- `Hydra-<version>-arm64-mac.zip.blockmap`
- `latest-mac.yml`

`latest-mac.yml`, the ZIP, and its blockmap form the signed macOS update feed consumed by `electron-updater`. The DMG remains the recommended first-install artifact.

## Local recovery

Local signed releases still use:

```bash
npm run dist:mac:release -w @hydra/desktop
```

If Apple notarization remains in progress past the local wait timeout, resume without uploading a duplicate submission:

```bash
npm run dist:mac:release:resume -w @hydra/desktop
```

Set `HYDRA_DISABLE_AUTO_UPDATE=1` only for packaged-app diagnostics where update checks must be suppressed.
