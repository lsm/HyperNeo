# Device commands in the compiled CLI

Use the shared isolation rules and the compiled-worker startup helper. From the
worktree root on the native build platform:

```bash
bun scripts/build-binary.ts --target bun-darwin-arm64
RUN=$(mktemp -d /private/tmp/hn-compiled-devices-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/compiled-worker-startup.ts dist/bin/hyperneo-darwin-arm64 "$RUN" --device-commands
```

The actual compiled binary starts its own test daemon on an ephemeral non-8399
port, with fresh HOME, DB and data directory, blocked discovery commands and no
provider keys. The same binary's `--help` must list `pair` and `devices`;
`devices` initially lists none; `pair` produces an approved first code. The helper
claims that code through the daemon's real `/pair` endpoint, verifies the phone
appears in compiled `devices`, and revokes it through compiled `devices revoke`.
Codes and generated credentials stay in memory and are not written to evidence.

Inspect `evidence/commands.json` (all exits zero, one human device, credential not
disclosed, revoked), `build.json`, `daemon.log` and `cleanup.json`. On the broken
entrypoint, both device commands report Unknown option instead of operation results, and help omits them. The helper
records these results before asserting, then stops the daemon in finally.

The Linux native binary build job runs this mode too. All five CLI targets in
`scripts/build-binary.ts` share `packages/cli/prod-entry.ts`. Native execution of
one platform does not verify another OS/architecture. The standalone `hyperneod`
entrypoint remains covered by startup-only mode; it is not the human CLI.
