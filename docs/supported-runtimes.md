# Supported runtimes

HyperNeo's daemon and native proof jobs use Bun 1.4.2. Development, CI builds and
release packaging use that pinned runtime. Install dependencies with
`bun install --frozen-lockfile`.

## Development

Run `make dev PORT=8484 DB_PATH=/absolute/disposable/daemon.db` from the repository
root. Each worktree needs its own database path. Verification uses fresh test
HOME/data directories and ephemeral ports through the shared Verify skill.

## Native verification

Run existing source-daemon and native worker checks with Bun. The native smoke
entry point is `scripts/bun-native-smoke.sh`, which requires one fresh absolute
evidence directory. Its wrapper retains receipts and removes synthetic data.
Follow `.claude/skills/verify/SKILL.md` and the relevant journey for isolation,
resource checks and cleanup. Model and operating-system security journeys keep
their own additional requirements.

## SDK subprocesses and tools

Node remains available for independent SDK subprocesses and tools that require
it. The owned SDK executable setting accepts Bun and Node. Public session config
creation and updates reject host-process controls. An unsupported executable
already present in stored config causes a clear error before SDK query setup.
The daemon retains ownership of the executable selected for supported sessions.

## Release packaging

Build with `make build` and compile with `make compile`. Keep runtime hash outputs,
compiled worker entry points and embedded asset handling stable. The existing
Windows compiled-worker smoke remains a required CI dependency.

## Filesystem security

The native safe filesystem backend uses Bun FFI on supported macOS and Linux
hosts. Descriptor-relative operations, no-follow flags, permissions, cancellation
and race checks remain required. Native backend availability and Windows behavior
must be verified separately for any platform change.
