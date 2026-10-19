# Running online tests and test daemons without real credentials

Online tests run the real Claude Agent SDK and Claude Code CLI against a local mock instead of a model provider. CI does this for every PR (`.github/workflows/main.yml`, "Run daemon online tests"). Use the same setup locally to check what a session actually sends the model before you deploy.

## Rules

- `NODE_ENV=test`, and a data dir and DB of the run's own. Never use the default `~/.hyperneo`.
- The only key is CI's `ANTHROPIC_API_KEY=sk-devproxy-test-key`, pointed at the local mock. No real key and no other provider key.
- Run under `env -i` with a temporary `HOME`. A shell started inside Claude Code carries `CLAUDE_CODE_*` variables (for example `CLAUDE_CODE_USER_EMAIL`), and the CLI copies them into every turn. With `USER` set, the CLI can also find the human's login in the macOS keychain.
- A daemon on a non-default data dir never uses the keychain (`credential-store.ts`, #7430), and a test daemon never loads the human's Claude Code login (#7474).

## Run one online test the way CI does

From the repo root, start the mock that CI uses (`.devproxy/README.md` explains the matching rules):

```bash
bun scripts/dev-proxy-stub.ts --port 8000 --config-file .devproxy/devproxyrc.json
```

Then, in another shell:

```bash
cd packages/daemon && env -i HOME="$(mktemp -d)" PATH="$PATH" TERM=dumb NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 HYPERNEO_TEST_DISABLE_SANDBOX=1 ANTHROPIC_BASE_URL=http://127.0.0.1:8000 ANTHROPIC_API_KEY=sk-devproxy-test-key node_modules/.bin/vitest run --config vitest.online.config.ts tests/online/convo/multiturn-conversation.test.ts
```

## Scripted model turns

Some tests run their own scripted model server in-process and need no proxy. `convo/neo-publication-sdk.test.ts` is the Neo example. Its server records every request and answers with a `neo.publication.publish` tool call. The test then checks three things: the publication is stored, root Neo's system prompt is `neoPrompt(null)`, and the human turn holds exactly the stored message, including its `(local time: …)` line. Copy that pattern to assert what a change sends the model. Run it like any online test, without the proxy step:

```bash
cd packages/daemon && env -i HOME="$(mktemp -d)" PATH="$PATH" TERM=dumb NODE_ENV=test HYPERNEO_USE_DEV_PROXY=0 node_modules/.bin/vitest run --config vitest.online.config.ts tests/online/convo/neo-publication-sdk.test.ts
```

Neo sessions run with empty commit and PR attribution, so the CLI adds no `<system-reminder>` of its own, and the test checks the human turn with nothing ignored.

## A test daemon in dev-proxy mode

With the mock from above running, start a daemon on a fresh data dir and DB and a port you have checked is free (`lsof -nP -iTCP:<port> -sTCP:LISTEN`):

```bash
T="$(mktemp -d)" && env -i HOME="$T/home" PATH="$PATH" TERM=dumb NODE_ENV=test HYPERNEO_DATA_DIR="$T/data" ANTHROPIC_BASE_URL=http://127.0.0.1:8000 ANTHROPIC_API_KEY=sk-devproxy-test-key bun packages/cli/main.ts --host 127.0.0.1 --port 8650 --db-path "$T/daemon.db"
```

Drive it over RPC (`neo.open`, `neo.message.send`). The stub logs only requests that matched no mock, with their method and URL (for example `no mock matched POST …/v1/messages`). It doesn't log bodies, and its canned replies won't match a real Neo prompt, so use the scripted pattern above to check content. If another session already holds port 8000, start the stub with `HYPERNEO_DEV_PROXY_PORT=<free port>` and point `ANTHROPIC_BASE_URL` at that port; it matches its mocks on any port. Stop the daemon and delete `$T` when you're done.
