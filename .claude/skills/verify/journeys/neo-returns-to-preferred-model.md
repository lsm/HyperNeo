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

Retain `return-to-preferred-neo.json` and `return-to-preferred-front.json`.
The record lives in the running session, so a daemon restart before the reset
leaves the session on its fallback until the preference is saved again.
