# Neo's work.start reuses an idle worker in the same place

When Neo calls `work.start`, the daemon first looks for a recorded worker of the same
adapter, idle (`done`) in the same folder, that holds no open todo and was never marked
unusable. If one exists, it receives the message and the receipt says `reused: true` with
its ref. Otherwise a new session starts. A human start always creates a new session.

Use the shared isolation setup in `../SKILL.md`, then:

```sh
RUN=$(mktemp -d /private/tmp/hn-work-reuse-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=error bun .claude/skills/verify/work-start-reuse.ts "$RUN"
```

The helper boots an isolated in-process daemon on an ephemeral port with a synthetic Git
folder and a synthetic open ask naming a repository. It calls `work.start` on the
`hyperneo` adapter through the daemon's operation registry: as Neo, as the human, and as
Neo again. Then it binds both workers to open todos and calls it as Neo once more. No
model turn or provider key is needed.

End state, from `evidence/work-start-reuse.json`:
- `humanStart.newSession` is true.
- `neoSecond.reused` is true; its ref is an existing worker, and the session count is unchanged.
- `neoThirdAllLeased.reused` is false; it is a new session, and the count grew by one.
