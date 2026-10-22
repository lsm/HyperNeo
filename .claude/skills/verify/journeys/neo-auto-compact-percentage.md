# Neo auto-compact percentage through the operation door

From the worktree root, using the shared isolation rules in SKILL.md:

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-compact-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/neo-auto-compact.ts "$RUN"
```

The helper starts an actual daemon on an ephemeral loopback port (never 8399),
with fresh HOME/data/SQLite and stubbed GitHub. No provider keys, model network
calls, real database copies or GUI are used. It drives `neo.preferences.set`,
`neo.open` and `neo.snapshot` through the public `operation.invoke` door. It
always closes its socket and all daemon instances in `finally`.

Observe in `$RUN/evidence/observed.json`:

- An old preference without a percentage uses the selected synthetic model's
  metadata (80), not an invented explicit preference. Save 70 while the real
  session state manager is synthetically busy: snapshot/settings may change,
  but effective session metadata stays 80. Its idle event applies 70.
- The production context resolver and ContextFetcher consume a synthetic SDK
  usage response: 1,000,000 capacity gives a 700,000 effective threshold. Existing
  explicit native-provider SDK settings add the 33,000 reserve, giving 733,000. This is
  synthetic usage through the production computation, not a real model turn.
- An ordinary session remains at model metadata 80. Opening a project returns
  the same root session. Current dev uses one Neo conversation for project/topic
  contexts; m404 removed separate project-holder bindings. The native Neo backstop enqueues an actual dormant /compact at 700,000
  while 699,999 does not. No model query is started by this check. Worker sessions are
  separately excluded by focused tests; no removed binding type is reintroduced.
- Integer 1 and 101 clamp to 10 and 100. Fractional/string/null values are refused.
  Preference and session-applied override remain 70 after daemon restart.

Focused suites cover omitted-percentage reset to metadata, non-finite input,
worker isolation, reserve math, no global catalog mutation, response-model
resolution and preservation of native-provider SDK thresholds. For full exact-head verification run:

```bash
bash .claude/skills/verify/neo-auto-compact-check.sh /private/tmp/hn-neo-compact-final-UNIQUE
```

This records the head, full checks, all shared tests, all Neo operation suites,
full context/model/query/mid-turn suites, real SDK alignment/recovery journeys,
and the deferred-alignment and percentage public-door proofs. SDK traffic uses
the existing local scripted model fixture only. See neo-model-alignment.md for
its isolation details; all sockets, SDK clients and daemons close in finally.

The percentage is copied into session metadata only at existing Neo idle
alignment, then the existing safe query-restart path refreshes SDK settings.
Busy sessions retain their previous applied value until idle. Native providers receive both a reserve-adjusted SDK window and the existing
daemon context-budget backstop only for explicitly configured Neo;
without it they retain their existing SDK settings/enforcement behavior. At 100 the existing
percentage backstop disable semantics remain unchanged. Omission restores model
metadata/default (normally 90); fallback-chain omission keeps its prior behavior.

This backend journey does not prove a Web control, GUI rendering, real provider
compaction or a timing race in a live SDK turn. Stage 2 owns the Web page.
