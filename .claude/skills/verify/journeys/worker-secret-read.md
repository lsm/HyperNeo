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
and 1Password are denied. Home credential directories remain denied; workers read a private gh configuration snapshot.
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

The disposable home contains a public gh config, synthetic Keychains/Git
credential fixtures, and valid hosts.yml plus hosts.yml.bak files containing
only a synthetic OAuth-token marker. No real home or credential is read by the
proof, and no live daemon, real provider or GitHub request is used.

Preparation snapshots only public config.yml into daemon-managed, read-only
GH_CONFIG_DIR metadata outside worker writable roots. Home .config/gh stays
denied in full, protecting token files, backups and other credential-bearing
leftovers without an extension allowlist. The snapshot refreshes with a unique
temporary file and atomic rename each time a worker is prepared; removal of the
source removes the stale snapshot. Custom denials and other credential rules
stay intact. Neo's separate policy is unchanged.

The fixture changes the public setting from https to ssh between preparations.
The actual Codex native sandbox loads production worker permissions and runs
`gh config get git_protocol`. The actual SDK Bash tool runs the same command
against a production Claude policy, using a scripted loopback model with a
literal synthetic key only in the SDK child. Both must observe the updated ssh
value and status zero. All four protected-file cats must return nonzero with
empty output; private gh-config writes must fail while repository output remains
writable. The focused regression additionally changes/removes the source config.

Signed failing-first commit 129108241 reproduced the original configuration
read failure; 71bd582d7 exposed the hosts token and 741025297 reproduced stale
snapshots and readable backups. Before the latest fix, native results show the
old https setting and a readable backup marker. Keep result.json,
codex-stderr.log, claude-stderr.log and claude-events.jsonl.

The helper closes its query/model listener and removes its worker runtime roots;
the shared wrapper saves evidence before deleting the disposable home/data.
This proves native configuration reads and file denials on the running host;
it does not prove live GitHub authentication, a push/merge, Linux enforcement,
or that an already-running turn has reloaded its policy. Existing workers need
the normal policy refresh on a subsequent turn; do not restart the live daemon.
