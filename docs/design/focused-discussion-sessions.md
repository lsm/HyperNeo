# Focused discussion sessions

Proposal; design only. Merge is on hold until the human approves through Neo,
then exact-head hyperneo-ai-test approval and green required CI are also needed.

## First implementation PR: source session on Neo question cards

After design approval, the first small PR changes **only Neo question cards**.
For every question derived from a worker's output, Neo stores that worker's
source session ref when it creates the card. In the card's **top-right corner**,
show the source session's **name and provider** and an **Open session** button.
Use the existing adapter opener to take the human straight into that exact
session for back-and-forth discussion, without Neo relaying it. Do not substitute
Neo's inbox or infer the author from the question text. A card with no single
source session shows no button. Opening is navigation, not an answer or approval;
the existing yes/no and Reply in chat controls keep their current semantics.
No other card, routing behavior or session lifecycle changes in this first PR.

## Route the ask

Proposed short rule for Neo's root prompt:

> When progress needs the human's continuing judgment, taste or back-and-forth
> (for example positioning, marketing strategy or a landing-page design), open a
> fresh focused session for that discussion; do not relay its conversation.
> Delegate bounded work with an observable result (a fix, PR, deploy or research
> report) normally. Research that prepares a discussion stays in its session.
> For a mixed ask, separate the discussion from execution; if intent is unclear,
> ask one short routing question before starting.

Inbox sessions, including Neo and functional leads, receive worker reports and
external events and coordinate execution. Focused sessions take direct human
input and their own scheduled checks, not unrelated worker/event fan-in. These
are session roles, not a new provider, messaging transport or permission tier.

## Prepare, then invite

Always offer a multi-provider **HyperNeo session** alongside available **Claude
Code in Desktop** and **Codex Desktop**. Honor the human's stated preference;
otherwise use HyperNeo and make the alternatives clear. Use existing discovery
and `work.start`, not an inbox session or a reused coordinator. Desktop choices
reuse [Claude's preparation/import/native delivery](https://github.com/lsm/HyperNeo/pull/8274)
and [Codex's Desktop handoff](https://github.com/lsm/HyperNeo/pull/8318).
A returned backend receipt alone does not prove desktop visibility. An unavailable
adapter is reported explicitly; switching harness requires the human's choice.

Seed the fresh session once with the human's words and source references, linked
documents, earlier decisions, constraints, open questions and the originating
ask/work reference. Distinguish quotations from Neo's summary and assumptions;
missing document access stays explicit. Its opening task is to research relevant
facts and produce two or three distinct drafts/options with tradeoffs and a short
agenda, before asking the human to join. Preparation permits no publishing,
deploying or other commitments beyond the ask's existing authorization.

The session reports prep readiness to Neo once. Neo sends **one readiness card**:
“Two positioning drafts and a comparison are ready. **Open session**.” Reuse the
existing publication/work-card presentation and adapter opener. Existing start
cards continue to authorize pending work; they are not a second invitation or a
new discussion-card kind. Current publication links are not a session opener:
allow just one optional `sessionLink` on the existing readiness card, using the
adapter-returned link bound to the ask's stored work reference. Never invent a
deep link or treat opening it as starting work or granting permission. Replays
update the same card using existing publication identity. If preparation fails,
report the blocker instead of claiming readiness or creating another session.

## Discuss directly, return the outcome

The human opens that exact session and talks to it directly. Neo does not join,
poll for conversational turns or forward questions, drafts and answers between
them. The session may run its own human-authorized scheduled checks through the
existing scheduler; worker/event reports continue to go to coordinator inboxes.

At the human's conclusion, the session sends one outcome through existing
`message.send`/`work.send` reporting: originating ask/work reference, decision,
remaining uncertainty, document links and any resulting PRs or execution tasks.
Record who decided and retain the human-decision reference when available; a
session summary is not human approval. If no decision was reached, say so.
Neo records that outcome in its existing ask/todo ledger, verifies any required
approval through the existing gate, and tracks subsequent execution. Ending a
discussion does not itself certify its PR merged or its deployment complete.

## Small implementation and acceptance

First verify source-ref persistence across reload, top-right name/provider and
opening the exact source, absent buttons without one source, and unchanged answers.
After that card-only PR, separate small slices cover routing/seed, readiness and
outcome binding using existing sessions, start flows and reports. No new
lead agents, ledger, scheduler, transcript mirror or automatic execution policy.
Verify with synthetic asks: a bounded bug delegates normally; a design ask
creates one fresh session, prepares options, opens from one replay-safe card and
records its final outcome without relaying discussion. Cover all three harnesses,
unavailable handoff and unchanged start approval semantics; Desktop rendering
needs separate human confirmation. This docs-only proposal proves no runtime
behavior and changes no prompt, API, schema or verification journey.
