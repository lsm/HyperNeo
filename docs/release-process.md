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

Generate an API compatibility report for the release notes before publishing:

The report includes phone-used push payloads once their source ref owns Zod
contracts. New coverage of a previously untyped payload is labelled coverage-only,
not a proven safe wire change; it is excluded from compatibility totals. Older
release tags stay untyped. Event payload changes use result compatibility rules.

```bash
bun run api:surface
bun run api:diff vPREVIOUS
# For two existing release tags:
bun run api:diff vPREVIOUS vCURRENT
```

The single-ref form compares the previous release with the generated working
snapshot, not a tagged release. The two-ref form compares exactly those commits.
When a tag predates `api-surface.json`, the tool collects its catalog from an
isolated checkout of that tag using the same generator. It reuses dependencies,
uses a synthetic home/database, refuses external HTTP/GitHub and removes its
temporary checkout and daemon data. Fetch the required tags first; use trusted
repository refs. No install or production daemon is needed for this report.

Include the summary and changes in release notes. For example:
`v0.52.0 -> v0.53.0: phone-used operations: 0 breaking, 0 risky, 1 safe`.
That release also removed **both `work` and `consultation`** from
`neo.publication.publish input.links[].kind`, leaving `project`. This is a real
input-contract removal, not a rename: the older publisher accepted then omitted
those links; the newer input schema rejects them. The new optional top-level
`session` field is a separate source-session reference, not a replacement enum
spelling. The pinned phone source does not publish through this operation.

Classification: new operations, optional input fields and result fields are
safe. Result enum/union additions and results becoming optional/nullable are
risky. Removed operations/fields, type changes, newly required inputs and removed
input enum values are breaking. Accepted input widening and result enum/union
narrowing are safe; other changed constraints are conservatively breaking.
Changed defaults and opaque transform fingerprints require review as risky.
Phone summary counts use each method's highest severity; the full list retains
each classified schema change. Event name changes are included, but event payload
schemas require their own surface support. Legacy transport methods without a
catalog schema are not validated by the operation comparison.

The default phone inventory is `api-phone-methods.json`. Refresh it from a
configurable source checkout and its released commit:

```bash
bun run api:phone-methods "$PHONE_SOURCE" "$PHONE_RELEASE_REF" > phone-methods.json
bun run api:diff vPREVIOUS vCURRENT --phone-methods phone-methods.json
```

The extractor reads committed product Swift files, excludes test directories,
and collects sorted unique literal `invoke`, `request`, `call`, `onEvent` and
named `*Request` helper method strings. It does not infer dynamically computed names. Review unexpected
inventory changes before replacing the committed default; do not put source
repository names or machine paths in it. `--json` emits machine-readable changes
and source commit identities.

Use `--worktree-root` to select a writable parent for historical detached
worktrees (the OS temporary directory is the default). Only one historical
checkout and proof daemon runs at a time; each is removed before the next.

The default source is commit `5a35d4d4bcabb7866ddfc95212a775ebc465979b`, reported as
phone app 0.5.0 (6). Its association with the installed TestFlight build is based
on owner-reported release/archive timing only; no durable upload receipt was
retained. This is source coverage, not proof of the installed binary's contents.

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
