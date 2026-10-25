# Prepared worker OS write enforcement

Read the shared native-worker isolation setup in `../SKILL.md` first.

```bash
RUN=$(mktemp -d /private/tmp/hn-sb-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  VERIFY_CLAUDE="$(command -v claude)" VERIFY_CODEX="$(command -v codex)" \
  bun .claude/skills/verify/worker-sandbox.ts "$RUN"
```

The helper owns an isolated daemon on an ephemeral non-8399 port and synthetic
Git repositories. Actual `work.start` RPC prepares the Claude clone and installs
its policy. Desktop registration uses a synthetic peer, never the human's GUI.
The installed Claude CLI loads that actual file through `--settings <path>` and
`--setting-sources local`, without injecting worker temp/cache variables into its
environment. Merely enabling the local source leaves protected env keys unapplied;
production creation, Desktop handoff and headless resume must pass the file too.
Codex uses the production desktop adapter with a synthetic bootstrap/handoff peer;
the real Codex CLI runs its generated thread configuration. This proves real OS
shell denial with adapter-generated policy, not native Desktop IPC or UI persistence.

Observe `evidence/{claude,codex}-observed.json`: both inside and private temp writes
succeed, outside writes fail. The corresponding stdout JSONL must contain the
shell's OS denial and nonzero outside status. Temp paths must stay inside each
worker's private root, including Claude's per-uid child directory. Long paths
cause Claude to fall back to shared `/tmp/claude-<uid>` and must fail this proof.
`codex-launch.json` and `codex-turn.json` retain both startup and opening policies.
The same run invokes `work.start` for the HyperNeo adapter and runs a real SDK
Bash turn. `sdk-observed.json` and `sdk-options.json` prove its private clone is
sandboxed too; `sdk-requests.json` retains the actual OS-denial tool result. The
helper stores only a synthetic provider key through RPC in its disposable DB,
disables external registry MCP servers, and routes SDK child traffic explicitly
to its own loopback model. No policy/env injection occurs in the SDK transport
wrapper. The daemon and model process close in finally; no fixed mock port is used.
All three routes also curl the synthetic server through the sandbox's configured
HTTP proxy. This proves HTTP network access, not real GitHub push/authentication.
Claude allows HTTP(S) hosts explicitly but grants no SSH-agent/Unix sockets; HTTPS
repository-token remotes are the supported path. SSH push is not verified.

Focused tests remove runtime roots before resuming a Claude worker or building SDK options; those paths must recreate
their own private dirs. Creating a sibling must preserve existing env/sandbox
configuration and must never prepare that sibling's released or unusable runtime.
Codex sends re-ensure only clones carrying the prepared-worker marker.

Commit `ab59e77f7d` contains the failing reproduction before enforcement: real
Claude writes the synthetic outside file. The regression helper exits nonzero.

Read denial, credential/environment isolation, arbitrary MCP/native-tool containment
and Desktop UI behavior are not proven here. Codex `workspaceWrite` exposes no
per-path read deny; secret-read isolation is tracked separately in #8630.
Copy evidence to a persistent location before deleting the synthetic run/worktree.

## Policy self-protection and report publication

The Bash probes also attempt to unlink `.git/hyperneo-native-writes.json`,
`.git/hyperneo-worker-sandbox` and `.claude/settings.local.json`. Both Claude
routes must report OS denials, preserve the gate markers and retain equivalent
policy JSON. The SDK settings manager may reformat JSON before the model runs;
formatting is not a policy change. The probe waits for the completed tool result
before checking preservation. Codex's sandbox policy is persisted in its thread,
not gated on the runtime-recreation marker.

The SDK Bash turn writes `sandbox-report.txt` in its actual
`HYPERNEO_HANDOFF_DIR`; the next scripted SDK MCP call invokes `handoff.publish`.
`handoff-published.json` must contain a real `published` reference for the synthetic
report. This proves the exported draft path matches the daemon reader and is
writable without granting the surrounding data directory.

Failing reproductions for review run 9434 were committed first in `04bebfb404`:
real Bash deleted its policy, report env pointed at the wrong directory, and
archive/delete retained runtime roots. No production clone-placement change is
part of this fix; the policy always takes its root from the prepared directory.

## Sibling runtime independence (review 9444)

The actual daemon proof releases the first worker's synthetic runtime, starts a
sibling through `work.start`, and requires the released root to stay absent. It
then puts an unusable regular file at that same owned runtime path; another
sibling start must still succeed. `sibling-runtime.json` records both results
and preservation of the original worker's env/sandbox. Native file permission
denies still refresh to include the new siblings. Unit regressions were committed
first in `c8ed6ebffe` and fail on the reviewed head.

Successful archive/delete runtime release is verified in the stacked lifecycle
follow-up, not in #8632. Failure cleanup and own-session runtime recreation remain
part of this core journey. The final stacked PR closes #8627 after both merge.
