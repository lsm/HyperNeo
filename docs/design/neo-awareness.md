# Neo stays aware of what happens around its asks

Status: proposal. Parts are in flight (#6277, #6285, #6289), and the rest are small.
Scope: how Neo learns that something changed, for the asks it's driving.

## The problem

Cards and asks drift from reality. Three times on 2026-10-10 the user found cards saying the wrong thing:

- An ask waited on decisions the user had already made. The decisions were made in another thread and shipped in other PRs.
- A card stayed "queued" after its PR merged, because the session it was sent to never reported it.
- Cards stayed wrong for two hours because a merged fix wasn't deployed.

Each was patched on its own path. The root cause is the same every time: **an ask only learns what its own cards report.** Anything that happens elsewhere never reaches it: another session, the user acting directly, a teammate.

## The principle

> Neo knows what happened by reading the world, not by waiting to be told.

Every live ask watches a few things. One loop reads them, and Neo is told once per change. Neo judges what the change means and settles, asks or continues. The daemon never decides an outcome on its own, except ticking an item whose check is exact (#6280).

## What an ask watches

| Source | Watched things | Read by |
|---|---|---|
| Started by Neo | Each card's session: running, idle, needs-you, its turns and the inputs that landed. The PRs it opened. | Driver refresh (#6277 for HyperNeo sessions), follow pass, card evidence (coding pack) |
| Named by the ask | PRs and issues in the ask's text, done items and evidence: URLs, `owner/repo#N`, and **bare `#N` resolved in the ask's repo** | Ask evidence (#6289, PRs only today) |
| Around the ask | The same issue or PR changed by someone else: the issue closed, a PR that closes it merged, a newer commit on the card's PR, a review or conflict | Ask and card evidence, the same reads |
| The human | An answer in the work session, a message to Neo | #6257, #6285 |

Neo writes references as `owner/repo#N` when it opens an ask, so "fix HyperNeo #5546" is stored as `lsm/HyperNeo#5546`. A bare `#N` left in an ask resolves only when its other references and its cards' PRs all point at one repo. Otherwise it's skipped. A wrong guess costs little, because only changes after the ask opened count.

## One loop

Two evidence streams feed the same loop: per card (#6268) and per ask (#6289). They never report the same change, because ask evidence skips PRs a card already tracks.

1. Every 60s, read the evidence for each live ask: its cards' evidence plus its own. GitHub is read at most every 15 minutes per ask, and sooner after a card reports.
2. Compare the canonical signature with what Neo was last told (`neo_work_checks`, `neo_ask_checks`).
3. If it changed, send Neo a note with what changed: "#6159 merged", "#5546 closed by #6255", "the card's session is idle". Notes arrive as turn inputs, so Neo sees them.
4. Neo settles, re-asks or continues. Waiting asks, the one input that used to be snapshot-only, are listed again if Neo skips them (#6285).

## Gaps, in priority order

| # | Gap | Example | Fix | Size |
|---|---|---|---|---|
| 1 | Bare `#N` is ignored | "fix HyperNeo #5546" names no URL | Neo records `owner/repo#N` when it opens the ask; a leftover bare `#N` resolves when the ask points at one repo | S, after #6289 |
| 2 | Issues aren't watched, only PRs | #5546 closed by a PR from another session | Read PRs and issues in one GraphQL call; an issue reports the PR that closed it | S, same PR as 1 |
| 3 | PRs a card's session opened but never named | the session forgets to paste the link | List PRs whose head branch is the session's branch | S (#6186) |
| 4 | A deploy waits on busy sessions | #6277 held for 2 hours | Deploy as soon as it merges. A restart doesn't lose a turn | Done (process) |
| 5 | The UI doesn't say how fresh a card is | "Queued" looks current | Show the last check: "checked 2 min ago" | S, web and iOS |

Deferred: one combined note per ask per pass. The two streams don't overlap, and two notes in a minute is rare. Not in scope: webhooks instead of polling (polling every 15 minutes is enough for asks that take hours); watching arbitrary sites or inboxes (that's a pack's evidence, such as life admin's confirmations).

## Done when

- e86cb4b0 (voice composer) settles from #6159 merging, with nothing done by hand.
- An ask "fix #N" settles when someone else's PR closes #N.
- No card or ask is wrong for more than 15 minutes after the change it depends on.
