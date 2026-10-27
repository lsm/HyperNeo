# Prepared worker secret-read isolation

Use shared native-worker setup in `../SKILL.md` and the existing
`worker-sandbox.md` journey. This journey needs a daemon host that can apply
OS sandboxes. A prepared worker already inside Seatbelt cannot run the nested
sandbox: `sandbox_apply: Operation not permitted` is inconclusive, never a pass.
Do not disable enforcement or retry with elevated privileges. Neo runs this
journey as the post-deploy smoke on the live build, using an isolated test daemon.
Never restart the live daemon or connect to port 8399.
Worker sandbox must be `always`: the helper sets it before `work.start`.
The default `off` preference intentionally provides no file isolation.

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
and 1Password are denied. Other credential config directories remain denied; worker gh configuration is readable.
Both policy writers must refuse symlinked `.git`, `.git/info` or `exclude`,
leaving synthetic host files unchanged during policy installation. Swapping
config files must not copy synthetic host TOML into the protected profile;
file reads use the already-opened no-follow handle.

Retain `evidence/*-stdout.jsonl`, `*-stderr.log`, `sdk-requests.json`,
`sdk-secret-read.json`, `codex-launch.json`, `codex-turn.json`, and each worker's
`secret-read-status-*.txt`, `secret-read-result-*.txt` and `repo-read-result-*.txt` before cleanup. CLI helper
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

Also run `codex-queued-loopback.md` on the host: it now probes the same synthetic
secret through an actual queued Codex app-server worker and asserts its named
profile. The synthetic-daemon send journey checks admission and receipt reporting
locally without claiming OS enforcement. Home filename rules cover the home root
and immediate children; tracked examples and key fixtures in nested private clones
remain readable. Known credential directories are denied recursively.
Workers intentionally allow Unix sockets; this journey proves file isolation
and does not test socket-mediated credential access.


## gh configuration regression (#9092)

Use the shared isolated setup/resource check in SKILL.md with this narrow native
proof. Supply the Desktop-bundled Codex executable and installed gh executable:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-gh-config.ts /absolute/codex-executable /absolute/gh
```

No credentials, real home, live daemon, provider, model reasoning or GitHub
request is used. The disposable home contains only `git_protocol: ssh` in
`.config/gh/config.yml`, plus synthetic Keychains and Git-credential fixtures.
The actual Codex native sandbox loads production worker permissions and runs
`gh config get git_protocol`. The actual SDK Bash tool runs the same command
against a production Claude policy refreshed from obsolete gh read denials,
using a scripted loopback model with a literal synthetic key only in the SDK
child. Both must return ssh with status zero. All protected-file cats must
return nonzero with empty output; ordinary repository output must remain writable.

Before the fix, both engines record `failed to read configuration: operation
not permitted`. Signed failing-first commit 129108241 also covers fresh grants
and legacy Claude resume. The upgrade removes only the exact generated gh
Read/denyRead entries; custom denials and credential rules survive. Codex profile
refresh regenerates its managed profile from the corrected shared worker paths.
Neo's separate read restrictions are unchanged.

Keep result.json, codex-stderr.log, claude-stderr.log and claude-events.jsonl.
The helper closes its query/model listener and removes its worker runtime roots;
the shared wrapper saves evidence before deleting the disposable home/data.
This proves native configuration reads and file denials on the running host;
it does not prove live GitHub authentication, a push/merge, Linux enforcement,
or that an already-running turn has reloaded its policy. Existing workers need
the normal policy refresh on a subsequent turn; do not restart the live daemon.


Review follow-up: the fixture now also creates a valid gh `hosts.yml` containing
only a synthetic OAuth-token marker. Before the fix, both engines can read that
marker (test-first commit 71bd582d7). The real home hosts.yml is now a denied
credential file. Each worker receives GH_CONFIG_DIR pointing to daemon-managed,
read-only metadata outside its writable roots; preparation snapshots only public
config.yml, never hosts.yml. Codex filesystem rules and Claude denyWrite protect
this directory. The native proof must still read the configured non-default ssh
value, deny all three secret-file reads, and refuse writes to its private gh
config. No live OAuth token is read, copied or passed to this fixture.
