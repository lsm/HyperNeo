# Coding session target

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-target.ts
```

The helper boots an isolated daemon with the coding pack, creates two real
HyperNeo sessions over RPC and records two finished synthetic coding todos that
worked in them as `frontend` and `backend`. It then asks the coding pack's
`workerTarget` hook, with live status from the daemon's own `work.status`
operation:

- unrelated work that asks to start a `backend` session is sent to the idle
  backend session instead;
- a later slice of the same feature follows it there;
- a feature whose recorded session `work.status` cannot find waits instead of
  starting another.

It then starts two ready coding todos through the todo runner, each stored with
a `backend` start target:

- the feature's ready slice is sent to the backend session, and its stored
  target becomes that send;
- the unreachable feature's slice stays a todo with its start target and a
  `session_unknown` wait reason, and nothing is dispatched.

Last, it checks reservations that never got a session:

- a feature whose owner failed without a session no longer makes the next
  slice wait;
- the pack's `workerTargetRefused` hook drops an unstarted todo's unbound
  reservation, and leaves a started todo's reservation in place.
- a finished owner retains its live session even for another work type;
- when a done or removed owner's session is missing, its next slice
  dispatches to a live session and takes over the reservation.
- with no live alternative, the next slice selects a fresh start; an
  unreachable session held by active work still causes a wait.

This journey covers feature reservations; missing PR-holder sessions follow the
separate PR-routing path and are not covered by this change.

Then it archives both sessions over RPC (`session.archive`):

- with only archived sessions in the repository, dispatch starts a new session
  and that todo becomes the feature's owner;
- when the owner's own session is then archived and a live idle session
  exists, dispatch sends to the live one and its todo takes the feature over.
