## SQLite preparation/open diagnostics

Read SKILL.md. On macOS with command-line tools and pinned Bun, use fresh
synthetic HOME/data and an ephemeral isolated daemon; no provider/mock API or GUI:

```bash
RUN=$(mktemp -d /private/tmp/hn-sqlite-phase-XXXXXX)
bash .claude/skills/verify/sqlite-phase-timing.sh verify prepare "$RUN"
RUN=$(mktemp -d /private/tmp/hn-sqlite-phase-XXXXXX)
bash .claude/skills/verify/sqlite-phase-timing.sh verify open "$RUN"
```

The shell compiles an interposer confined to this owned run path and one named
synthetic statement or database. It delays the actual native prepare/open by
1400ms. The daemon's real RPC handler performs that call and returns 219 to an
independent client. The real lag detector must still report >=1s: this PR only
adds diagnostics and must not claim a latency fix. No sampler is enabled.

On the red-first commit, `reproduce` records the missing phase; `verify` fails.
After the change exactly one normalized `sqlite.phase.slow` reports that phase
and duration, correlated with the recovered event-loop tick. Native execution
and query summaries remain separate; never add a phase to its enclosing call.
`observed.json` retains phase/tick records, caller/RPC time, correct return value
and 10,000 cache-hit/2,000 cache-miss timing samples. Cache hits have no prepare
phase. No DB path, bound values or private SQL literals may enter the events.
The helper stops its child, lag detector and daemon in finally. No real DB,
credentials, external network, stored-data deletion or production mutation occurs.

Bun/Deno contract tests cover phase success/error, cache identity, privacy,
unobserved silence and unchanged SQL execution summaries. Existing native close
journey remains separate; this journey does not enable its opt-in native sampler.

With the same isolated environment, run `sqlite-phase-contract.ts` beside these
helpers using both `bun` and `deno run -A`; it uses only an in-memory database.
