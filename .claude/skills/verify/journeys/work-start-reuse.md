# Neo's work.start reuses an idle worker in the same place

When Neo calls `work.start`, the daemon first looks for a recorded worker of the same
adapter, idle (`done`) in the same folder, that holds no open todo and was never marked
unusable. If one exists, it receives the message and the receipt says `reused: true` with
its ref. A todo first prefers its ask's most recently used eligible worker;
different-ask reuse prefers the worker whose latest ask settled longest ago.
Unknown settlement history remains a fallback. Otherwise a new session starts.
A human start always creates a new session. Use ask-worker-affinity.md for the
recorded-history and pack-exclusion proof.

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
Neo again. Then it binds both workers to open todos and calls it as Neo once more.
Last, it leases that new worker too, opens a session in the folder the way a human
does, binds it to a finished review todo, and calls `work.start` as Neo for a build
todo. No model turn or provider key is needed.

End state, from `evidence/work-start-reuse.json`:
- `humanStart.newSession` is true.
- `neoSecond.reused` is true; its ref is an existing worker, and the session count is unchanged.
- `neoThirdAllLeased.reused` is false; it is a new session, and the count grew by one.
- `neoBuildBesideFreeHumanReviewer.gotReviewer` is false: the free human-opened
  session is never reused, so the build gets a new session and the count grows by one.

`evidence/session-reuse-dispatch.json` additionally records a fresh session under
`per_todo` and a doing todo returning to the queue when its ask's workers are busy
under `per_ask`.
When an already-bound todo cannot be queued on a busy worker, it starts a
fresh session instead of reporting a wait that was never recorded.
The helper also forwards a start through the destination's real RPC door while
an unrelated worker is idle. The forwarded start creates a fresh session. Remote
`per_ask` waiting is not implemented by this route.
Starts with no todo or a todo owned by another Neo also start fresh when the
daemon cannot determine which matter's reuse setting applies.
