# Activate atomic ask settlement (#8712 core 4c)

Use SKILL.md's resource guard, existing dependencies and a fresh absolute
evidence directory. Keep one heavy job at a time:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/ask-settlement-activation.ts verify
```

This owns an isolated daemon with real reader/writer workers. Call the actual
`neo.ask.settle` WebSocket RPC and agent MCP handler for `neo.ask.open` split
activation; read full public Work cards through `neo.ask.read`. Only work.stop
is scripted, using the production operation schema and invocation boundary.
No live daemon, provider, external GitHub request or real worker process is used.
Before activation the first public settle fails on main-thread settlement SQL.

Require whole-family rollback on a late card write failure, without a successful
settlement notice. Hold a WAL writer only when settlement reaches its commit:
neither success nor settlement table/Neo notifications may precede release,
while health and current cards still answer. Legitimate worker-status writes
are separate from settlement notifications. The stop fixture opens/rolls back
a main transaction and awaits a writer-lane status update before returning,
proving driver effects finish outside settlement transactions.

After release, the committed receipt and actual public card retain the entire
Unicode report and prior diagnostic. Unfinished work is closed unverified,
never counted done; the unanswered card is retired without an invented answer.
Repeated/missing settlement attempts produce no new notice. Failed stops leave
the ask open with partial-stop diagnostics, while adopted workers are exempt.
A newly added todo and a replacement ref landing during another stop must be
included in the committed receipt and post-commit cleanup. A competing actor's
settlement must not be overwritten or announced as this operation's success.

Retain #9072: an open question and a pending answer each keep the human hold;
retirement with no pending answer releases it; explicit settlement closes the
work unverified. The MCP split path settles only an empty parent, retains child
asks/todos/reports/cards unchanged, announces once and stays quiet on repetition.
Late root work keeps its parent open; a late parent-card failure rolls back.
Unit tests also pin failed-stop/concurrent-settlement diagnostics and publication
only after the writer receipt is delivered.

Trace explicit settlement SQL and require zero matching main-thread calls.
The split-open command/decision is off main, but the rest of ask.open still
has existing creation/routing/family-response SQL outside this slice. No broader
main-thread claim is made. Preserve existing ask/state/stop compatibility tests,
run the full check and required Deno smoke. Label local Deno unverified when
unavailable. Keep #8998/#9002/#8712 open.

The helper saves `ask-settlement-activation.json`, stops all owned transports,
workers and daemon in finally, and the wrapper removes temporary proof data
after saving evidence. Writer-run evidence is not independent Verify sign-off.
Neo routes Review and independent Verify on the exact head and recorded contract.
Deployment smoke is applicable after merge and remains a separately recorded
owner gate. GUI/native-iOS, real provider stops and the contention latency target
are not verified by this synthetic backend journey.
