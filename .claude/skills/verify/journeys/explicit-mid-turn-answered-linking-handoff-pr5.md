## Explicit mid-turn Answered linking (handoff PR5)

```bash
RUN=$(mktemp -d /private/tmp/hn-answered-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-answered-linking.ts "$RUN" 9365
```

The actual SDK consumes the real Neo prompt generator, initially a synthetic
todo-event turn. While its first model request is running, two synthetic human
messages are stored and steered into that turn. The local scripted model reads
the daemon-generated `<human-input>` metadata from its actual request, then
calls `neo.publication.publish` through SDK/MCP using the second human trigger.
`observed.json` records requests, receipts and the durable publications. Both
human messages begin Received; the same status projection used by the chat UI
must show only the selected message Answered. The producer stays the todo event.
Reopening only the synthetic SQLite database and replaying the identical publish
must return the existing receipt without another publication. `evidence.json`
records this result and maximum heartbeat lag against 1 s. The helper closes
its SDK stream, queue, loopback model and database in `finally`.

On the failing reproduction commit, the actual model request has no daemon IDs
and both messages remain Received. Focused contracts also reject foreign,
nonhuman, unconsumed and older-turn IDs, keep initial and mid-turn content
unchanged, and prevent a selected answer from answering a different producer.
This proves the real SDK/MCP path and chat status projection, not GUI rendering
or a killed-process recovery. No real provider, credentials, live DB or 8399.

Also run the focused `neo-prompt.test.ts` unit contract: the root instructions
must stay under their existing 160-word budget. The online
`tests/online/convo/neo-publication-sdk.test.ts` checks the actual daemon/SDK
request: one exact daemon ID envelope, then the unchanged local-time and human
text blocks. Run that test with CI's Node Vitest runner and
`vitest.online.config.ts`, from `packages/daemon`, with `env -i`, a fresh test
HOME/data dir and TMPDIR. The Bun runner aliases `bun:sqlite` back into the
compatibility module and cannot run this online configuration; the standalone
mid-turn helper above runs directly under Bun. Both checks retain receipt replay.
