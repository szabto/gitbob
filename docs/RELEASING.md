# Releasing GitBob

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on macOS, Windows and Linux runners and published to [GitHub Releases](https://github.com/szabto/gitbob/releases) as pre-releases while GitBob is in alpha.

## Cut a release

1. Make sure `main` is green in CI.
2. Bump the version: `npm version 0.2.0 --no-git-tag-version`, commit (`Release 0.2.0`), push.
3. Tag and push the tag:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The **Release** workflow builds and uploads:

   | Platform | Files |
   |---|---|
   | macOS (Apple Silicon and Intel) | `GitBob-<version>-mac-arm64.dmg`, `GitBob-<version>-mac-x64.dmg`, plus `.zip` |
   | Windows (x64) | `GitBob-<version>-win-x64.exe` (installer) |
   | Linux (x64) | `GitBob-<version>-linux-x86_64.AppImage`, `GitBob-<version>-linux-amd64.deb` |

5. Check the release page, edit the notes if needed.

You can also start the workflow manually (Actions → Release → Run workflow) to test packaging without a tag.

## Current state: unsigned builds

Builds are **not signed with a Developer ID** yet. macOS builds are signed *ad-hoc* (a valid signature without an Apple account; an unsigned or stale signature makes Apple Silicon Macs kill the app at launch):

- **macOS** shows "GitBob can't be opened because Apple cannot check it for malicious software". Users open it once with right-click → **Open**, or run `xattr -dr com.apple.quarantine /Applications/GitBob.app`.
- **Windows** SmartScreen shows "Windows protected your PC". Users click **More info** → **Run anyway**.
- **Linux** AppImage/deb need no signing.

## Enabling signing

### macOS (signing + notarization)

Requires an Apple Developer Program membership.

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate and export it with its private key as a `.p12` file (with a password).
2. Create an **app-specific password** for your Apple ID at appleid.apple.com.
3. Add these repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | the `.p12` file, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
   | `CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | your 10-character team ID |

4. In `electron-builder.yml` replace `identity: '-'` with your identity (or remove it to auto-discover), set `hardenedRuntime: true`, add an entitlements file allowing JIT (`com.apple.security.cs.allow-jit`) and `notarize: true` under `mac:`.
5. In `release.yml` remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and pass the secrets above as environment variables to the packaging step.

### Windows

With a code-signing certificate (`.pfx`), add `WIN_CSC_LINK` (base64 of the `.pfx`) and `WIN_CSC_KEY_PASSWORD` as secrets and pass them to the packaging step on the Windows runner. Cloud signing services (e.g. Azure Trusted Signing) are also supported by electron-builder.

## Auto-update

The app currently only checks GitHub Releases for a newer version when the user asks (Settings → About & updates) or opted in. Automatic download and install (electron-updater) requires signed macOS builds and will be added once signing is configured.
