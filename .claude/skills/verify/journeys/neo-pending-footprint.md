# Pending and durable reply footprints

Follow SKILL.md shared setup, isolation and resource guards. Build the current
web checkout. With existing NODE_PATH and VERIFY_BROWSER dependencies, run from
the repository root.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-pending-footprint-web.mjs
```

The shared launcher owns the fresh keyless NODE_ENV=test daemon, pairing and
random ports excluding 8399/8499. It saves evidence, stops its servers and deletes
temporary daemon data. The browser stays on its isolated origin and delays the
real send request by 1100ms without substituting its reply.

At 1280px and 390px, use separate fine-pointer and touch browser contexts. Set
`hasTouch: true` for touch and assert the actual `(pointer: coarse)` media query.
Use tap on the send button for touch, and Enter for the fine-pointer keyboard.
Reuse only the synthetic pairing state in memory. Send synthetic history, quote a
message longer than the stored 300-character excerpt and send plain and multiline replies. Capture the pending row after 650ms and
the durable row after acceptance. Require identical composer/pending/durable quote
text, row heights, and the bubble's offset from its row's bottom, within 2px.
Inspect the pending/durable screenshots and evidence.json. Record text typography
alongside geometry to diagnose a mismatch without relaxing the assertion.

This checks the message's own footprint. Viewport position is deliberately
measured by the send-flight journey in the next slice, which changes when the
composer quote disappears and pins the conversation to its bottom. Passing this
journey alone does not establish a jump-free flight or viewport landing.
