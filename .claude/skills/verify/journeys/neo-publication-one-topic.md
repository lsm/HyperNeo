## A publication's short line names every topic it covers

```bash
RUN=$(mktemp -d /private/tmp/hn-topics-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/publication-topics.ts "$RUN" 9366
```

The actual SDK runs a Neo turn against a local scripted model that calls
`neo.publication.publish` through SDK/MCP three times. First it sends the
incident's shape: two topics, each a top-level line starting with a bold label
and a full-width colon (`**Claude Desktop 环境**：…`, `**qlark 长听写开关**：…`),
under a short line that names only the first. Then it publishes each topic on
its own, each short line naming its topic.

End state: the first receipt the model reads is `accepted: false`, `reason:
multiple_topics`, with a detail that names both labels and says to publish each
topic separately or name every label in shortText. Only the two single-topic
publications are stored. `observed.json` and `evidence.json` in `$RUN` hold the
receipts and stored publications.

With the `requireShortTextCoversTopics` pipe removed, the first publish is
accepted with both topics under one short line and the helper fails. No real
provider, credentials, live DB or 8399. Delete `$RUN` afterwards.
