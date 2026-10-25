# Notification target outside the snapshot window

Use the shared isolated metadata-only setup: fresh HOME/data, NODE_ENV=test,
no model/provider/GUI or live daemon. Run from the checkout root:

```sh
RUN=$(mktemp -d /private/tmp/neo-notification-read-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR=/tmp NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/notification-ask-read.ts "$RUN"
```

The helper starts its own ephemeral daemon, seeds 101 synthetic asks and an old
failed todo/question, and proves the target really is absent from neo.snapshot.
It then reads that exact ask through neo.ask.read over the real WebSocket,
checks todo/question identities and full failure evidence, and checks a missing
ask returns not_found. Instrumentation must observe zero main-connection reads
of ask, todo, question or session-link tables. Inspect
`evidence/notification-ask-read.json`. Cleanup is automatic.

Run the same helper from the pre-fix checkout for a failing Unknown operation
reproduction. Run ask-entry unit contracts and the repository checks as well.
This does not verify phone notification taps; the iOS app owns that journey.
