# @neokai/desktop

A self-contained desktop wrapper for HyperNeo built with [Tauri 2.x](https://v2.tauri.app/).

The package ships the `neokai` daemon as a Tauri **sidecar** (an external binary
bundled and launched by the Rust shell) and renders the existing web UI inside
a native webview. There is no separate frontend code — Tauri opens a small
loading splash, polls the daemon's `/api/health` endpoint, and then navigates
the webview to `http://localhost:9283` once the daemon is ready.

```
┌─────────────────────────────────────┐
│  Tauri webview                      │
│  ┌──────────────────────────────┐   │
│  │ packages/web (served by      │   │
│  │ the bundled neokai daemon)   │   │
│  └──────────────────────────────┘   │
│              ▲                       │
│              │ HTTP / WebSocket      │
│  ┌──────────────────────────────┐   │
│  │ neokai sidecar (compiled bun │   │
│  │ binary, port 9283)           │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Prerequisites

- [Rust toolchain](https://rustup.rs/) — `rustc` 1.77+ on the host.
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/) — `cargo install tauri-cli` (or `cargo install tauri-cli --version "^2"` to pin to v2).
- Bun ≥ 1.3.8 (already required by the monorepo).
- Platform-specific build tools (Xcode CLT on macOS, MSVC build tools on Windows, the standard `webkit2gtk` stack on Linux). See the Tauri prerequisites page above for the per-OS list.

## Layout

```
packages/desktop/
├── package.json              # @neokai/desktop, scripts that wrap cargo tauri
├── build-sidecar.sh          # builds the daemon and copies it into src-tauri/binaries/
├── README.md
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # productName: "Kai", devUrl: http://localhost:9283
    ├── build.rs
    ├── capabilities/         # Tauri permission manifests
    ├── icons/                # bundle + tray icons
    ├── loading/index.html    # splash shown until the daemon answers /api/health
    ├── src/{main.rs,lib.rs}  # Rust shell: tray, global shortcut, sidecar mgmt
    └── binaries/             # populated by build-sidecar.sh — gitignored
```

## Development

The Rust shell does **not** spawn the sidecar in debug builds; it expects you
to run the daemon yourself so `cargo tauri dev` doesn't fight a real binary.

In one terminal, from the monorepo root:

```bash
make dev DB_PATH=/tmp/beokai-9283 PORT=9283
```

In another:

```bash
cd packages/desktop
bun run dev
```

The webview opens directly on `http://localhost:9283`. Hot-reload of the web
UI works exactly the same as in the browser — Tauri only owns the window.

## Build

A release build is fully self-contained:

```bash
cd packages/desktop
bun run build
```

Under the hood this:

1. Runs `bun run build:sidecar`, which calls `bun run scripts/build-binary.ts --target <bun-target>` from the monorepo root and copies the produced `dist/bin/hyperneo-<arch>` into `src-tauri/binaries/neokai-<rust-target-triple>`.
2. Runs `cargo tauri build`, which embeds that binary as the `externalBin` and produces an installable bundle for the host OS in `src-tauri/target/release/bundle/`.

Cross-target builds use the `build:macos`, `build:macos-intel`, `build:macos-universal`, `build:windows`, `build:linux`, and `build:linux-arm` scripts. They each rebuild the sidecar for the matching bun target before invoking `cargo tauri build --target <triple>`.

> **Note:** the build-sidecar script only produces a binary for the host
> `rustc --print host-tuple`. To cross-build the sidecar for a different
> platform you currently need to run `bun run scripts/build-binary.ts --target <bun-target>`
> at the monorepo root and copy the result yourself; richer cross-compilation
> wiring is a follow-up.

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

- Spawns `neokai --port 9283 --workspace ~/.kai` on startup (release mode only).
- Streams stdout/stderr into the Tauri log plugin.
- Polls `http://localhost:9283/api/health` for up to ~15 s and then navigates
  the main window from `loading/index.html` to the live UI.
- Hides the window to the system tray on close (instead of quitting).
- Kills the sidecar when the app exits.

## Open decisions

This package was added with conservative defaults — see the corresponding PR
description for the items still up for review (product name vs. `HyperNeo`,
updater endpoint, dev port choice, mobile parity, fate of the standalone
`~/focus/kai/desktop` repo).
