---
id: neo.question.hold
---
The human puts an open card aside (held true) or takes it back (held false). A held card stays open with heldAt set, with no timer, until the human answers it or takes it back, or the daemon retires it because its check passed or its ask settled. Its todos keep waiting, it no longer counts as needing the human, and Neo cannot retire or replace it. Send a new requestId for each press: a requestId already applied is ignored, so a delayed retry never undoes a later change. Holding a held card, or taking back one not held, changes nothing. Only an open card can be held.
