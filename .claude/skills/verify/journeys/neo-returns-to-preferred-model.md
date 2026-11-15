# Neo and the front return to their preferred model after a limit clears

Use SKILL.md's in-process RPC proof setup with PROOF set to
`.claude/skills/verify/return-to-preferred.ts`, once with `--neo` and once with
`--front` before the run directory. No HTTP model mock is needed: the SDK is
scripted and external HTTP is refused.

The helper saves Haiku as the preferred model (Neo's preference, or the front
model) and Sonnet as the global fallback. The first turn on Haiku returns a
usage limit that resets four seconds later; the turn recovers on Sonnet.

Observable results, each asserted:
- after the limit the session runs Sonnet and the watchdog records Haiku's
  reset time;
- a Neo sweep before the reset leaves it on Sonnet;
- a sweep after the reset moves it back to Haiku and clears the record;
- the next turn answers on Haiku.

Repeat each role with `--restart` as well: after the fallback the helper stops
the daemon and boots a new one on the same database. The session must still be
on Sonnet with Haiku's reset time stored in its metadata, and the sweep after
the reset must move it back to Haiku. Without the stored record this fails.

Repeat all four runs with `--pick`: after the fallback (and after the restart,
when given) a human picks Sonnet through `session.model.switch`, the picker's
RPC. Sonnet is the fallback the limit record names, so only the pick itself can
stop the return. The stored record must be gone after the pick, and after the
reset the session stays on Sonnet and the next turn answers there.

Retain the eight `return-to-preferred-*.json` files.
