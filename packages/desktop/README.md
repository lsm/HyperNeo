# @hyperneo/desktop

A self-contained desktop wrapper for HyperNeo built with [Tauri 2.x](https://v2.tauri.app/).

The package ships the `hyperneo` daemon as a Tauri **sidecar** (an external binary
bundled and launched by the Rust shell) and renders the existing web UI inside
a native webview. There is no separate frontend code — Tauri opens a small
loading splash, polls the daemon's `GET /` readiness route, and then navigates
the webview to the daemon once it is ready.

If a daemon is already running it advertises itself in `<data-dir>/runtime.json`
(`~/.hyperneo/runtime.json` by default); the shell attaches to that instance
instead of spawning a second daemon onto the same SQLite file, whose PID lock
would reject it. When neither an advertised daemon nor a freshly spawned sidecar
comes up, the shell reports the failure inside the window instead of leaving the
splash spinning.

Desktop startup settings are read from `io.hyperneo.app/settings.json` in the
user's platform configuration directory (Application Support on macOS). The
optional JSON fields are `dataDir`, `port`, `workspace`, and `daemonEnv` (an
object of additional environment variables). Paths must be absolute. The
environment variables `HYPERNEO_DATA_DIR`, `HYPERNEO_DESKTOP_PORT`, and
`HYPERNEO_DESKTOP_WORKSPACE` override their respective settings. If omitted,
the app retains its default data directory, port 9283, and workspace.

```
┌─────────────────────────────────────┐
│  Tauri webview                      │
│  ┌──────────────────────────────┐   │
│  │ packages/web (served by      │   │
│  │ the bundled hyperneo daemon) │   │
│  └──────────────────────────────┘   │
│              ▲                       │
│              │ HTTP / WebSocket      │
│  ┌──────────────────────────────┐   │
│  │ hyperneo sidecar (compiled   │   │
│  │ bun binary, port 9283)       │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Prerequisites

- [Rust toolchain](https://rustup.rs/) — `rustc` 1.77+ on the host.
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/) — `cargo install tauri-cli` (or `cargo install tauri-cli --version "^2"` to pin to v2).
- Bun 1.4.4 (the monorepo pin).
- Platform-specific build tools (Xcode CLT on macOS, MSVC build tools on Windows, the standard `webkit2gtk` stack on Linux). See the Tauri prerequisites page above for the per-OS list.

## Layout

```
packages/desktop/
├── package.json              # @hyperneo/desktop, scripts that wrap cargo tauri
├── build-sidecar.ts          # builds the daemon and copies it into src-tauri/binaries/
├── README.md
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # product, window and build configuration
    ├── build.rs
    ├── capabilities/         # Tauri permission manifests
    ├── icons/                # bundle + tray icons
    ├── loading/index.html    # splash shown until the daemon answers GET /
    ├── src/{main.rs,lib.rs}  # Rust shell: tray, global shortcut, sidecar mgmt
    └── binaries/             # populated by build-sidecar.ts — gitignored
```

## Development

Install dependencies from the monorepo root with `bun install --frozen-lockfile`.

```bash
cd packages/desktop
bun run dev
```

The Tauri dev hook builds the host daemon and copies it next to the debug app.
The app attaches to a running daemon advertised in the configured data directory
or starts the sidecar itself. The default address is `http://127.0.0.1:9283`.
The app uses the same local-device sign-in as a release build.
Restart the dev command to rebuild changes to the web UI embedded in the sidecar.

## Build

A release build is fully self-contained:

```bash
cd packages/desktop
bun run build
```

Under the hood this:

1. Runs `bun run build:sidecar`, which calls `bun run scripts/build-binary.ts --target <bun-target>` from the monorepo root and copies the produced `dist/bin/hyperneo-<arch>` into `src-tauri/binaries/hyperneo-<rust-target-triple>`.
2. Runs `cargo tauri build`, which embeds that binary as the `externalBin` and produces an installable bundle for the host OS in `src-tauri/target/release/bundle/`.

Cross-target builds use the `build:macos`, `build:macos-intel`, `build:macos-universal`, `build:windows`, `build:linux`, and `build:linux-arm` scripts. They each rebuild the sidecar for the matching bun target before invoking `cargo tauri build --target <triple>`.

> **Note:** the build-sidecar script only produces a binary for the host
> `rustc --print host-tuple`. To cross-build the sidecar for a different
> platform you currently need to run `bun run scripts/build-binary.ts --target <bun-target>`
> at the monorepo root and copy the result yourself; richer cross-compilation
> wiring is a follow-up.

### Signed macOS builds

Set `HYPERNEO_SIGNED_DESKTOP=1` for the macOS release path. It downloads the
pinned Cua driver v0.55.0 from GitHub, checks its SHA-256 and version, and bundles
the executable and its license notices. Configure Tauri with the Developer ID
Application identity for team P5R65T296V and Apple notarization credentials.
The build requires the app and nested driver signatures and a stapled ticket.
Local builds without this flag use the standard Tauri bundle.

## GitHub release

Tagged releases build desktop artifacts in `.github/workflows/release.yml`. The workflow
produces signed and notarized macOS artifacts for Apple Silicon and Intel, plus unsigned
Linux x64 artifacts, and attaches them to the GitHub Release after npm publishing succeeds.

The release workflow requires these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` certificate |
| `APPLE_SIGNING_IDENTITY` | Exact signing identity, for example `Developer ID Application: Example Inc (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY` | App Store Connect key ID |
| `APPLE_API_PRIVATE_KEY` | Raw contents of the downloaded `AuthKey_<KEY_ID>.p8` private key |

Use a Team App Store Connect API key for notarization. Individual keys cannot
use Apple's notary service. The desktop package version, Tauri config version,
and Cargo package version must match the release tag, just like the other
workspace packages.

## Sidecar architecture

Tauri's [sidecar](https://v2.tauri.app/develop/sidecar/) feature lets the
desktop app ship and launch a precompiled child process. The Rust shell:

- Attaches to a daemon advertised in the configured data directory when one is
  running; otherwise spawns the sidecar with the configured settings.
- Streams stdout/stderr into the Tauri log plugin.
- Waits for the daemon to answer, then navigates from the splash to the live UI.
  For a daemon at `127.0.0.1`, the app uses the owner-only local credential to
  sign in as the local device and skip pairing. If the credential is missing
  or invalid, the cookie cannot be installed, or the daemon advertises a
  different host, pair manually when prompted.
- On failure (spawn error, early sidecar exit, or readiness timeout) renders the
  reason — including the daemon's own error line — inside the splash instead of
  spinning forever.
- Hides the window to the system tray on close (instead of quitting).
- Kills the sidecar when the app exits.

## Open decisions

This package was added with conservative defaults — see the corresponding PR
description for the items still up for review (updater endpoint, dev port
choice, mobile parity, fate of the standalone `~/focus/HyperNeo/desktop`
repo).
