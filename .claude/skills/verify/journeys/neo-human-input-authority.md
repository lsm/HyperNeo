# Human message ids and cited authority in Neo

Run from the worktree root with a fresh absolute run directory:

```bash
bash .claude/skills/verify/neo-human-input-authority.sh /tmp/hyperneo-human-authority-fresh 9362
```

Shared setup stays in SKILL.md: isolated HOME/data/DB, `env -i`, NODE_ENV=test,
synthetic credentials only, GitHub stub and loopback models. Disable external
registry MCP servers through RPC as described in SKILL.md; inline operations
remain available. The SDK/daemon and
restart proofs own ephemeral ports. The last argument is the worker proof's
local model port; it must be free and never 8399. Helpers close their resources.

A human message sent through `neo.message.send` is stored beginning with
`[message id: <uuid>]`; its local time and original human text/photos remain.
The public-conversation record retains the human's original content. Retries,
including pre-id stored messages, retain the same prompt and do not rerun it;
changed-content retries are refused.

The installed SDK sees the id and invokes `neo.rule.save` citing the approving
human message's id. The daemon verifies that the message is a consumed human
input received in this conversation, then retains its session/message reference
with the saved rule. Paraphrases do not require a matching quote; immutable
question-bound confirmation remains the preferred path when approval is needed.
Focused operation contracts refuse unknown, foreign, non-human, unconsumed and
non-conversation ids. See [human-approved standing-rule edits](human-approved-standing-rule-edits.md)
for the direct-save reference, settings-update preservation and restart proof.
Client-originated local human edits and question-bound
consent continue to work. Message ids identify received input; they do not
create a new delivery lane or infer an answered input.

The shared restart journey proves an ordinary session's human input has no new
header and both ordinary/Neo sessions preserve interruption and drain four
queued model markers after one restart. The actual worker SDK/MCP/CLI proof
keeps the existing session-message envelope, without a human message-id header.

Evidence: `sdk/evidence/neo-goal-cycle-sdk.json` (model input and MCP receipts),
`restart/evidence/spent-admission-{ordinary,neo}.json`, `worker/evidence.json`,
and `evidence/unit.log`. No GUI, live-daemon mutation or real-provider behavior
is claimed by these helpers. Optional publication/question `replyTo` and removal
of the legacy implicit-attribution store follow separately.
