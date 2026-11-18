# Every Neo reply body stays short

Read shared setup in SKILL.md. This uses the actual daemon, the Neo MCP operation
handler and the human RPC reader, with no model subprocess:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-body-limit.ts
```

Neo is asked to write at most 60 words. Separately, the server refuses reply text
over 400 characters; it counts characters, not words or lines, so a title with
several bullets fits as long as it stays under 400 characters. The limit applies
with or without details, so a text over it is refused either way: without details
as `reply_needs_details`, with details as `reply_summary_too_long`, each explained
with "keep the title, the conclusion and any decision in text and supporting
material in details".

Neo publishes four bodies over the limit: a long sentence alone, a long
translation sent without the deliverable flag, a long sentence with longer
details, and the same sentence with shorter details that would fold into it. All
four are refused, so the flag is what exempts a deliverable rather than its size.

A long drafted email sent with `deliverable: true` is exempt from the limit and
accepted; the same email with details is refused as `deliverable_with_details`
because a deliverable is the whole message. The accepted deliverable is above
16,000 characters, which proves the exemption clears the ordinary field cap and
stops at the deliverable's own 64,000-character ceiling.

A short text with the long text in details, a three-line Markdown body and an
eight-line title-and-bullets body under 400 characters are accepted, alongside
the deliverable. The human reader shows exactly those four, in order, and the delivered deliverable is read back in full.

The limit counts characters, not UTF-16 code units: 400 emoji measure 800 code
units but exactly 400 characters, so that reply is accepted and read back in
full, while 401 emoji and 401 plain characters are both refused. The numbers
live once in the shared publication types, and the refusals and tool description
are built from them.

The front's own 150-character cap is unchanged and covered by the front-flow
unit test, not by this daemon proof.
