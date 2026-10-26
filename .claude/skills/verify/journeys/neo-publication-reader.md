# Authored Neo replies reach the public-conversation reader

Run from the worktree root:

```bash
bash .claude/skills/verify/publication-reader.sh /tmp/hyperneo-publication-reader-fresh
```

Use a fresh absolute run directory. Shared isolation from SKILL.md applies:
`env -i`, `NODE_ENV=test`, its own HOME/data/DB, synthetic DB-stored credentials,
GitHub stub, an ephemeral daemon and a loopback model on ephemeral ports. No
live daemon, real provider or credential file is used. Resources close in finally.

The installed SDK receives a human message with its intake-stored message id,
invokes `neo.publication.publish` through MCP, retries the same publication
idempotently with explicit replyTo, then cites that received human id and its exact words in
`neo.rule.save`. The rule is saved without a turn object before plain text ends
the turn. A second reply goes out as `verbatim: true` with one text field:
fenced and quoted content must come back byte-identical from the read RPC,
stored with the flag and no `shortText`. It also asks a question through MCP with the same replyTo id; question.get retains it. Missing, foreign, queued and non-human ids are refused in the focused
human-authority contracts.
The web's actual `readNeoPublications` client reads that newly authored reply
through the test daemon's WebSocket RPC. It must return `ready` with the same
stored text and no inferred askOrigin/producerInput; plain terminal text must not
add a publication. Previously the daemon accepted these replies but the web
reader returned `unavailable`, making the public conversation unreadable.

`evidence/neo-goal-cycle-sdk.json` records model requests, SDK tool receipts,
stored publication and the actual web-reader result. `evidence/sdk.log` and
`evidence/web.log` record checks. The web contracts also cover origin-less
revisions alongside legacy attributed replies, malformed optional origins,
public conversation rendering and bounded reads. This is a daemon-to-web-client
proof plus component rendering; no GUI or browser rendering is claimed.

For the CI-equivalent transport control without OS sandbox probing, run the same
script with `HYPERNEO_TEST_DISABLE_SANDBOX=1`. This still uses the real SDK,
loopback model and WebSocket/web reader, but does not claim OS sandbox proof.
The conversation must contain the one daily count card alongside the scheduled
wake and exactly one model-authored reply; a plain-text reply adds no publication.
