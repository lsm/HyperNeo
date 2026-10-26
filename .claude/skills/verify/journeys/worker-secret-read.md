# Prepared worker secret-read isolation

Use shared native-worker setup in `../SKILL.md` and the existing
`worker-sandbox.md` journey. This journey needs a daemon host that can apply
OS sandboxes. A prepared worker already inside Seatbelt cannot run the nested
sandbox: `sandbox_apply: Operation not permitted` is inconclusive, never a pass.
Do not disable enforcement or retry with elevated privileges. Neo runs this
journey as the post-deploy smoke on the live build, using an isolated test daemon.
Never restart the live daemon or connect to port 8399.

Run the existing daemon/real-CLI proof with the additional environment variable:

```bash
RUN=$(mktemp -d /private/tmp/hn-secret-read-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn VERIFY_SECRET_READ=1 \
  VERIFY_CLAUDE="$(command -v claude)" VERIFY_CODEX="$(command -v codex)" \
  bun .claude/skills/verify/worker-sandbox.ts "$RUN"
```

The helper creates only synthetic bytes at the disposable home's
`.ssh/hyperneo-synthetic-secret` and a readable fixture inside each prepared
repository. Daemon `work.start` produces the actual policies. Claude CLI, Codex
CLI using the adapter launch configuration, and the HyperNeo SDK worker each run
`cat` on those two fixtures. The secret read must return nonzero while the repo
read returns exactly `synthetic-repo-readable`. A missing result is a failure.
The Codex opening-turn receipt must select `hyperneo-worker`, without a legacy
`sandboxPolicy` overriding it. Its launch config defines that named profile.
The clone's protected `.codex/config.toml` must also define it: restart/resume
the prepared Codex worker through the daemon, repeat both reads, and retain the
turn result. Bootstrap-only definitions are insufficient for Desktop handoff.
Unsupported app-servers must refuse prepared startup without a confirmed active
profile and refuse queue admission when their profile catalog is absent or
disallows the worker profile. A repo tracking `.codex/config.toml` is refused
without changing its bytes. Library toolchain paths remain readable; Keychains
and 1Password are denied. The broader `.config` denial is intentional.

Retain `evidence/*-stdout.jsonl`, `*-stderr.log`, `sdk-requests.json`,
`sdk-secret-read.json`, `codex-launch.json`, `codex-turn.json`, and each worker's
`secret-read-status-*.txt` / `repo-read-result-*.txt` before cleanup. CLI helper
assertions fail on either incorrect result; the SDK assertion runs after the
actual daemon turn. Existing outside-write, temp, Git and network checks must
also pass. Copy evidence out, stop owned children using the existing helper's
finally cleanup, and delete the disposable run. Never inspect host credentials.

Local policy-only fallback: run the `worker-secret-read.test.ts` daemon suite.
It asserts generated Codex profile grants and persisted Claude sandbox/native
Read rules, including a legacy resume. Runtime-directory preparation is mocked
because the owning session cannot create another worker's private OS roots.
These results prove policy generation only, not OS enforcement, native Desktop
IPC, arbitrary MCP containment, Keychain/1Password IPC, or live GitHub auth.
Pre-profile Codex workers that cannot resolve the profile refuse queue admission;
recreate them as prepared workers rather than restoring workspaceWrite.
