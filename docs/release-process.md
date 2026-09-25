# Release Process

Releases go directly from the `dev` branch via version tags.

## Steps

### 1) Bump version and update changelog

Create a branch from `dev`, bump the version in all `package.json` files, update `CHANGELOG.md`, and run `bun install` to update `bun.lock`:

```bash
git checkout -b release/vX.Y.Z origin/dev
# Update version in all package.json files: root, packages/*, npm/hyperneo,
# npm/hyperneod (including its optionalDependencies pins)
# Add CHANGELOG.md entry
bun install
git commit -m "chore(release): bump version to X.Y.Z"
git push -u origin release/vX.Y.Z
```

Open a PR: `release/vX.Y.Z` → `dev`

### 2) Tag after merge to `dev`

Once the version bump PR is merged to `dev`:

```bash
git checkout dev
git pull --ff-only origin dev
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release.yml` is triggered by `v*` tags and validates:

- Tagged commit is on `dev`
- Package versions match the tag version
- CI passed for the tagged commit

### 3) GitHub Release

The release pipeline creates a GitHub Release automatically. If it fails (e.g., auto-generated notes are too long), create it manually:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

## Release targets

| Artifact | Targets | npm packages | GitHub Release |
| --- | --- | --- | --- |
| CLI binary (`packages/cli/prod-entry.ts`) | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64` (`.exe`) | `@hyperneo/cli-<target>` optional deps of `hyperneo` | attached |
| Standalone daemon binary (`packages/cli/daemon-entry.ts`) | `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (no Windows yet) | `@hyperneo/hyperneod-<target>` optional deps of `hyperneod` | attached |
| Desktop (Tauri) | `darwin-arm64` (.dmg + .app.zip), `darwin-x64` (.dmg + .app.zip), `linux-x64` (.deb + .rpm), `windows-x64` (.msi + NSIS `_setup.exe`) | — | attached (+ per-arch SHA256SUMS) |

- CLI binaries are distributed via npm platform packages (`@hyperneo/cli-<target>` optional dependencies of `hyperneo`; on Windows `npm install -g hyperneo` resolves `@hyperneo/cli-windows-x64` and the `hyperneo` shim launches `bin/hyperneo.exe`).
- The standalone daemon ships the same way: `npm install -g hyperneod` resolves `@hyperneo/hyperneod-<target>` for the platform and exposes the `hyperneod` binary. Its install path is documented in `docs/supported-runtimes.md`.
- Every smoke-tested target (all except `linux-arm64`) boots the compiled binary on its native runner and runs the RPC smoke suite before upload; daemon binaries run the same suite with `--daemon`.
- The release version check covers `npm/hyperneo` and `npm/hyperneod`, so both wrapper packages (including their optionalDependencies pins) must be bumped with every release.
- npm publishing uses Trusted Publishing (OIDC); a first-time publish of a new package (`hyperneod`, `@hyperneo/hyperneod-<target>`) requires wiring it up as a trusted-publishing partner for this workflow in npm settings first.
- macOS desktop artifacts are signed and notarized in CI. Linux and Windows installers are **unsigned**: Windows shows SmartScreen warnings until a code-signing certificate is wired up (`bundle.windows.certificateThumbprint` in `tauri.conf.json`; the workflow passes no signing secrets for Windows today).

## Dry runs (workflow_dispatch)

`release.yml` can also be dispatched manually from any ref. With the `publish` input off (the default) it runs the build, desktop, and package jobs only — the way to validate new targets (e.g. the Windows legs) without touching npm or creating a GitHub Release. The dev-branch and CI-wait gates apply to tag pushes only. With `publish` on, the dispatch must run from the commit carrying the `v<version>` tag (the release-retry path); dispatching publish from an untagged ref fails in `wait-for-ci` so an existing release's assets can never be clobbered from a branch build.
