# Focused discussion sessions

Design only. MERGE HOLD until the human approves through Neo; exact-head bot
approval and green required CI are also required.

## First PR: open the source from every worker-derived question

When Neo opens **any question card derived from a worker's output**, it stores
that source session ref. The **top-right corner** shows the session's **name and
provider** plus **Open session**, using the existing adapter opener to go straight
there. With no single source session, show no button. This first implementation
PR changes **only Neo question cards**, preserving their answer controls.

## Route and prepare

Short prompt rule for Neo:

> Use a fresh focused session when an ask needs continuing human judgment or
> back-and-forth, such as positioning or landing-page design. Delegate bounded
> fixes, PRs, deploys and research normally. Decide when reasonably possible;
> ask a routing question only when genuinely ambiguous.

Inbox sessions (Neo and functional leads) coordinate workers and events. Focused
sessions are human-driven, with their own scheduled checks. Always offer a
multi-provider **HyperNeo session**, alongside available **Claude Code in
Desktop** or **Codex Desktop**. Use the human's preference and existing
`work.start`/handoff flows ([Claude #8274](https://github.com/lsm/HyperNeo/pull/8274),
[Codex #8318](https://github.com/lsm/HyperNeo/pull/8318)) to create the fresh session
in its app. Seed it with the human's words, linked docs and earlier decisions.

The session prepares first: relevant research and drafts where drafts fit (a
landing page), or clear questions and options where those fit better
(positioning). When ready, Neo sends **one card** saying what is prepared with
**Open session**, reusing existing card presentation such as start and its
existing approval semantics and the source-session opener. Keep the link on the
**ask itself**
so the human can reopen a multi-day discussion after a question card is retired.

## Discuss directly; keep Neo informed

The human talks directly with the session. Keep the existing
[turn-end relay (#8263)](https://github.com/lsm/HyperNeo/pull/8263): each turn's final
reply may reach Neo. Neo knows this is a human-and-agent one-to-one discussion;
relayed turns are **status only**. Neo does not act on them, reply into them,
forward them or treat them as approval.

When the human says it is settled, the session sends the outcome tied to the ask:
decision, documents and PRs. Neo records it in the existing ledger and tracks
execution. Later small PRs add routing/prep, readiness and the persistent ask link,
then outcome integration, reusing existing sessions, cards, scheduler and relay.
