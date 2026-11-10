# Direct human turns in an owned Copilot worker reach Neo

Use shared SKILL.md isolation, pinned Bun 1.4.2 and the resource guard. The helper
owns ephemeral loopback model/daemon ports, a fresh home and database, a refusing
gh stub and a synthetic framed-JSON-RPC Copilot CLI. External registry MCP servers
are disabled; SDK sandbox disabling is only for the synthetic Neo transport.
No fixed-port preflight, real account or native Copilot UI is needed.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/neo-human-turns.ts copilot
```

The public work.start door drives the pinned official Copilot SDK. The tester
feeds a synthetic CLI human-input boundary while the original daemon input
remains held. The CLI emits/persists a different input ID, final reply and idle;
it is not a daemon work.send receipt. Bind the worker to a completed todo on an
open ask with a follow anchor and no dispatch row. Real work.status must expose
the human input and completed turn, then the driver-refresh job delivers both
fields to Neo. Neo's SDK/MCP tool adds one todo on that same ask. Two further
observations add no model request or todo. All owned fixture PIDs must exit on
cleanup. Preserve observed.json, model-bodies.json, copilot-calls.json and
proof.log; require wrapper exit 0 without closed-database shutdown errors.

For mode copilot-before, retain this branch’s helper and CLI fixture, restore
only the production files to the test-only commit, and restore them afterwards.
The missing report reproduces after the fixture emits its turn. The two process contracts separately use a finished,
reaped owner and append native-history fixture records: a direct human turn
reports once, while an exact daemon receipt produces the normal dispatch report.
They also assert input IDs, time, text, human attribution and repeat protection.

This proves the real daemon/official SDK/report/Neo tool path with synthetic
protocol peers, not real-account Copilot execution or real-model judgment.
Owned histories retain their existing 256 KiB, final-path no-symlink read bound;
observation projection retains 64 inputs, returns at most 50 inputs since the
anchor (8 without one), and at most 39 turn ends. A complete native idle/outcome
is required; clipped history alone never invents completion. Snapshot metadata
and durable daemon receipt IDs preserve attribution for evicted and older rows.
No external session is adopted, resumed or replayed by a status read. Run the
existing Copilot lifecycle/input/history/retention contracts with this journey.

Repeat with mode copilot-busy to emit 60 earlier native human inputs before the
completed direct turn. The newest input must still reach Neo with its own text
and reply, create one same-ask todo and remain deduplicated. Inputs returned by
status remain chronological: up to 50 since the anchor, prioritizing the selected
turn endings and then newest other inputs; newest 8 without an anchor. The
process contract also checks a turn that finishes after 60 later pending inputs.
Mode copilot-busy-before on the pre-review-fix production source reproduces the
wrong attribution and missing same-ask todo; retain this helper and CLI fixture.
