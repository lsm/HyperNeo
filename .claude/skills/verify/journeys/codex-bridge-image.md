# Claude Code images through the Codex provider

Use this live journey when the task authorizes use of the local Codex sign-in.
The two modes submit synthetic images to the real Codex backend. They can create
synthetic native Claude Code history under the signed-in home.

Build the web bundle from the head under test. Use the pinned Bun version from
the shared setup. Pick a free loopback port other than 8399 and use a fresh run
directory with `data`, `tmp`, `workspace`, and `bin` subdirectories. Install
`gh-stub.sh` as `bin/gh`. Start the source daemon with a clean environment,
the signed-in HOME, and explicit disposable data and DB paths.

```bash
env -i HOME="$HOME" PATH="$RUN/bin:$PATH" TMPDIR="$RUN/tmp" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts --host 127.0.0.1 \
  --port "$VERIFY_PORT" --db-path "$RUN/data/daemon.db" --workspace "$RUN/workspace"
```

Use an owning shell with an EXIT trap to stop and wait for this daemon. After
HTTP readiness, register the provider in the disposable daemon only.

```bash
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT
bun .claude/skills/verify/rpc.ts rpc:providers.create \
  '{"params":{"providerId":"anthropic-codex","displayName":"OpenAI (Codex)","kind":"built_in","authType":"oauth","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{}}'
```

Set `NODE_PATH` to the Playwright dependency directory, `VERIFY_BROWSER` to a
Chromium executable, and `VERIFY_EVIDENCE` to an existing evidence directory
outside the run. Run each mode in a fresh browser context.

```bash
node .claude/skills/verify/codex-bridge-image.mjs rejected
node .claude/skills/verify/codex-bridge-image.mjs valid
```

Each mode opens a Claude Code chat with GPT-6-Luna from Codex and sends one
image turn. Expect an image decode error for the bad-checksum PNG and a reply
of “Red” for the valid 32×32 PNG, with no API retries in either case. Retain the
screenshots and exit statuses. Stop the daemon before removing its run data.
