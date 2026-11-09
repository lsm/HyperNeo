# Plain follow-ups stay on the selected open ask

Follow SKILL.md isolation and pinned runtime setup on the designated test host.
Run the resource preflight, then use a fresh absolute run directory.

```bash
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/ask-binding-daemon.sh /tmp/hyperneo-ask-binding-fresh
```

For an archived source snapshot without Git metadata, supply its verified full
commit SHA as the second argument. Git checkouts reject a supplied SHA that
differs from HEAD. Archives require a full SHA and label it declared-archive.
The proof pairs that identity with actual source-file SHA-256 hashes and their
combined material hash in evidence/source-material.json. Compare those hashes
against the claimed commit before accepting archive evidence. The SHA is also
recorded in evidence/head.txt.

The helper starts an isolated daemon with NODE_ENV=test, fresh HOME, data and DB,
an ephemeral port, no provider and a refusing gh stub. It stops its job processor
before seeding one synthetic Neo session. Human messages A and B enter through
its authenticated WebSocket RPC. The actual Neo invoke tool runs over the MCP
SDK's linked JSON-RPC transports with the synthetic session's identity.

The first neo.todo.add call uses input A and opens one ask. Plain message B then
continues it through neo.todo.add with input B and that askId. A later call with
input B alone must reach the same ask. The helper prints ask count 1 and both
follow-up todos' askId, and asserts that one neo_ask_inputs row owns message B.
The proof counts SQL mentioning neo_ask_inputs on the main daemon connection
during these calls. It records that measured count, then requires it to be zero.
A nonzero count fails the proof and remains in its failure evidence. This checks
that registered input-binding operations use the actual gateway workers. This proves the public input and tool paths without
a model turn or web UI.

It then settles that synthetic ask through neo.ask.settle and reuses input B to
open a fresh ask. Two simultaneous neo.todo.add calls for a further plain input
must share one new ask. The old ask stays settled, and the evidence records both
concurrent receipts and the new input owner.

Retain evidence/ask-binding.json and head.txt alongside the command exit status.
The helper closes the WebSocket, MCP client/server and owned daemon in finally.
After copying evidence, remove only that run's synthetic data and HOME.

The focused neo-ask-input-binding unit file also covers refused mismatched replies,
settled/foreign/unknown targets, unchanged input-only creation and competing
bindings, including an insert interleaved after a stale ownership read.

Both new asks and explicit bindings now use the same atomic gateway claim. The
helper submits a mixed input-only/explicit-bind pair in each submission order.
Each pair must select one owner, every refused bind must name that winner, and
later input-only work must reuse it without an extra ask. Evidence records both
submission orders and their receipts. The focused unit test controls claim order
to cover both winning paths, and a forced link-insert failure checks that a newly
opened ask rolls back with its link.

The helper also changes a synthetic target after planning but before the actual
MCP claim reaches its write transaction. Settled targets must return ask_settled;
removed or transferred targets must return not_owned. These refusals create no
new ask or todo. Evidence retains all three replies in claimRefusals.
