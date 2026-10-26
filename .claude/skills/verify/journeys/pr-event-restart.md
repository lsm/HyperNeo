# A non-terminal PR event survives a restart, and an unowned skip is logged

Use shared isolation in `../SKILL.md`; no provider/model/GUI is needed.

```sh
RUN=$(mktemp -d /private/tmp/hn-pr-event-restart-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/pr-event-restart.ts "$RUN"
```

The helper owns an ephemeral test daemon with GitHub/Claude stubs and rejects
all external fetches. A synthetic repo with no merge policy has an owned PR
(#188) and an unowned PR (#2). The production coding-pack sweep records #188
at waiting_human. A changes-requested observation is then written through the
real ledger gateway and its transition return discarded, and the daemon
restarts before delivery (neo-ios#188 head 32fcdd4). The next sweep must
enqueue exactly one owner mailbox message saying changes were requested, and a
repeated sweep must not add another. The unowned PR turning failing must log
`PR event ... skipped: synthetic/no-policy#2 has no owner`.

Inspect `evidence/pr-event-restart.json` for the ledger before and after the
restart, the owner mailbox, and the skip warnings. This proves durable owner
mailbox acceptance, not provider consumption or native Claude Desktop delivery.
No real DB, live daemon or 8399 access is part of the helper.

The fixture explicitly watches its synthetic repository before the first sweep.
That watch survives restart; merge-policy preferences remain unanswered.
