# An actual Neo turn asks a card without replyTo (#8600)

Follow the shared isolation rules in `../SKILL.md`. From the worktree root:

```sh
RUN=$(mktemp -d /private/tmp/hn-card-consumed-turn-XXXXXX)
mkdir -p "$RUN/home"
cd packages/daemon
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error VERIFY_EVIDENCE_DIR="$RUN/evidence" \
  node_modules/.bin/vitest run --config vitest.online.config.ts \
  tests/online/convo/neo-card-reply-turn.test.ts > "$RUN/test.log" 2>&1
```

This uses the installed SDK and a real isolated daemon with ephemeral loopback
model/daemon listeners, synthetic provider credentials registered in its own DB,
an empty HOME and an SDK config directory under the fixture. External registry
MCP servers are disabled and the fixture's gh stub refuses every call. No real
provider, credential file, live DB/daemon, port 8399 or GUI is used. The fixture
disables SDK OS sandboxing for this transport/operation proof; it does not prove
sandbox enforcement. Its finally block closes the daemon, SDK and HTTP resources.

The human sends “周六还是周日去 Costco？用卡片问我” through `neo.message.send`.
The loopback model waits while a teammate/task prompt is consumed in the same
turn. The processing status now names the teammate input. A live MCP reconcile
must retain the attempt-bound operation server. The model calls the
actual MCP `neo.question.ask` twice with identical inputs and no `replyTo`.
The public publication read must contain exactly one typed, localized notice
associated with the original human UUID and one open question. The human message
remains read, not answered. Repeated publication reads retain the same row.

A subsequent background-only turn asks another question and creates no notice;
a distinct later human input gets its own notice. Evidence in
`$RUN/evidence/card-reply-consumed-turn.json` includes the model calls, actual MCP
receipts, processing status, questions, public pages and human status. These are
runtime/public-reader observations, not an injected consumedInputId. On the
pre-fix commit the first notice-count assertion fails with expected 1, actual 0.

Keep running `card-reply-daemon.md` as the separate atomicity, replacement,
retry/restart and explicit caller-context contract. Its injected identity alone
does not prove this real-turn fallback. No web/iOS rendering or post-deploy phone
retry is claimed by either daemon-only journey.

For the ACP coordinator path, use another fresh run from the worktree root:

```sh
RUN=$(mktemp -d /private/tmp/hn-card-reply-acp-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/card-reply-acp.ts "$RUN"
```

No HTTP model mock or credentials are needed. A synthetic stdio ACP agent uses
the daemon's shipped MCP proxy command to call `neo.question.ask` without replyTo
twice after actual human chat intake is consumed. The publication page must have
one notice linked to that human UUID and the question must not duplicate. Its
next background-only prompt creates a question without borrowing the human
association. The first assertion fails with zero notices before ACP wiring.
Evidence is `evidence/card-reply-acp.json` and `evidence/acp-protocol.jsonl` in
the synthetic run. The same ACP proof runs in the online regression file above.
The helper closes its owned daemon, ACP client and MCP proxy in finally; no real
provider, live DB, credential file, fixed TCP port or GUI is used.

## Structured background reports

With the #8647 wake gate, a free-form teammate report waits in the durable
queue. A fixture that requires immediate background work must send an explicit
question report through message.send, including when it steers the active human
turn. The ACP and SDK fixtures must retain their original publication assertions:
one notice linked to the human, no duplicate question, and no human association
borrowed by a later background-only question.

The pre-update fixtures reproduce CI run 40182192213: the SDK fixture waits for
an untyped teammate input to be consumed, and the ACP fixture times out waiting
for its untyped BACKGROUND_CARD turn. In the ACP evidence, the human notice is
present, no background prompt was sent, and one neo_notes row remains pending.
This is the requested queue behavior, so update the fixture's structured input
rather than making untyped worker chatter wake Neo again. Keep the neo-wake-queue
journey as the independent twenty-message quiet-burst contract.
