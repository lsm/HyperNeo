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

The ask's repo is the repo of its cards' place, or of the PR or issue it names. That's enough to resolve "fix #5546".

## One loop, one note

There are two evidence streams today: per card (#6268) and per ask (#6289). They should be one:

1. Every 60s, read the evidence for each live ask: its cards' evidence plus its own. A read is throttled per source: GitHub at most every 15 minutes per ask, and sooner after a card reports.
2. Compare the canonical signature with what Neo was last told (`neo_work_checks`, `neo_ask_checks`).
3. If it changed, send Neo one note for the ask, listing what changed: "#6159 merged", "#5546 closed by #6255", "the card's session is idle".
4. Neo settles, re-asks or continues. A note isn't spent until Neo's turn has seen it (#6285's rule, for every note).

## Gaps, in priority order

| # | Gap | Example | Fix | Size |
|---|---|---|---|---|
| 1 | Bare `#N` is ignored | "fix HyperNeo #5546" names no URL | Resolve `#N` against the ask's repo | S, in #6289 or right after |
| 2 | Issues aren't watched, only PRs | #5546 closed by a PR from another session | Read named issues: state and the PRs that close them | S |
| 3 | PRs a card's session opened but never named | the session forgets to paste the link | List PRs whose head branch is the session's worktree branch | S (#6186, parked) |
| 4 | Two notes for one ask | card and ask evidence change in one pass | Merge them into one note per ask per pass | S |
| 5 | A deploy waits on busy sessions | #6277 held for 2 hours | Deploy as soon as it merges. A restart doesn't lose a turn | Done (process) |
| 6 | The UI doesn't say how fresh a card is | "Queued" looks current | Show the last check: "checked 2 min ago" | S, web and iOS |

Not in scope: webhooks instead of polling (polling every 15 minutes is enough for asks that take hours); watching arbitrary sites or inboxes (that's a pack's evidence, such as life admin's confirmations).

## Done when

- e86cb4b0 (voice composer) settles from #6159 merging, with nothing done by hand.
- An ask "fix #N" settles when someone else's PR closes #N.
- No card or ask is wrong for more than 15 minutes after the change it depends on.
