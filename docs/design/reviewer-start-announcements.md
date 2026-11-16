# Reviewers send Neo the verdict, not the start

Status: proposal, 2026-11-16. Design only.

## Why

Neo is woken by every report another session sends it. Reviewers send the most: in seven
hours on one install, review sessions sent Neo 476 `done` reports. About 278 were verdicts.
About 90 only said a review had started ("Review started at exact checkout …. Static
review only … auto depth resolves to deep …"). The rest were resumes, rechecks and
clarifications.

Verdicts must reach Neo at once. An approval is what Neo records with `neo.coding.result`
before the cross-model gate lets the daemon merge; a request for changes is what sends the
builder back to work. Holding either costs time for nothing. So report delivery stays as it
is: every report kind wakes Neo.

The start reports are the waste, and one prompt line asks for them. The review policy
(`packages/prompts/src/workflows/guidance/review-policy.md`, included by
`agents/system-contracts/reviewer-system-contract.md`) says:

> State the active review source and depth when you start review-relevant work, and record
> them in your review or gate artifact.

Review sessions working for Neo follow the first half literally: their start reports name
exactly the source and depth ("Source: internal cross-model review; standard depth"). The worker rules already say to message Neo only at
milestones, with no progress pings (`packages/prompts/src/neo/packs/coding/worker-rules.md`).

## The design

The policy line becomes:

> Record the active review source and depth in your review or gate artifact; a reviewer
> that reports to Neo puts them in its verdict message.

Nothing else changes. The source and depth still reach Neo, inside the verdict. Verdicts,
`blocked`, `question` and `failed` reports, human messages and the daemon's own notices
wake Neo as today.

## Change plan

One PR from `dev` (the repository's default and target branch), one prompt line.
`bun run system-map impact` lists `review-policy.md` as not a mapped source file; it is
included by the reviewer contract and the coder-only and coder-owned workflow prompts, which
take the new text unchanged. Render both Neo sessions' prompts and a reviewer's prompt
before the PR and read the review policy section in each.

Acceptance, on the live install for the next day of reviews:

| Case | Expected |
|---|---|
| A review session starts a review | no message to Neo |
| It finishes | one verdict message, with source and depth, wakes Neo at once |
| A verdict asking for changes | wakes Neo at once (unchanged) |
