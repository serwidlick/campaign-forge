# Updates and releases

## Updating the app

A few seconds after launch, and every few hours after that, the app asks GitHub Releases whether a newer version exists. If one does, a strip appears across the top: **Install and restart** downloads it, installs it and reopens the app. The cross dismisses it until the next version. The welcome screen also has a **Check for updates** link next to the version number.

Updates are signed. The app installs a package only when its signature matches the key built into the app, so a tampered download is refused.

On Windows and with the Linux AppImage the update installs itself. The `.deb` is reinstalled by hand from the download page.

Copies of 0.1.0 predate the updater and need one last manual download.

## For whoever makes releases

Installers are built on GitHub Actions for Windows, macOS (Apple Silicon) and Linux by the Release workflow. To ship a version:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same number.
2. Commit, then tag and push the tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

3. Wait roughly twenty minutes. The workflow publishes the release with installers, signed update packages and the `latest.json` manifest the app reads. The download page picks it up by itself.

The private signing key is a repository secret. Losing it means installed copies can never update again, so keep a copy somewhere safe. macOS builds are signed and notarised when the Apple secrets are set; see the repository README for the list.
