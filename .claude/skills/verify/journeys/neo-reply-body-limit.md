# Every Neo reply body stays short

Read shared setup in SKILL.md. This uses the actual daemon, the Neo MCP operation
handler and the human RPC reader, with no model subprocess:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-body-limit.ts
```

The reply text is at most 200 characters and at most 5 lines counting every line
including blank ones, the title counting as a line. The limit applies with or
without details, so a text over it is refused either way: without details as
`reply_needs_details`, with details as `reply_summary_too_long`, each explained
with "put a one-sentence summary in text and the rest in details".

Neo publishes six bodies over the limit: a long sentence alone, a six-line list,
a five-line body padded with blank lines, a long translation sent without the
deliverable flag, a long sentence with longer details, and the same sentence with
shorter details that would fold into it. All six are refused, so blank lines
cannot buy space and the flag is what exempts a deliverable rather than its size.

A long drafted email sent with `deliverable: true` is exempt from the limit and
accepted; the same email with details is refused as `deliverable_with_details`
because a deliverable is the whole message. The accepted deliverable is above
16,000 characters, which proves the exemption clears the ordinary field cap and
stops at the deliverable's own 64,000-character ceiling.

A one-sentence summary with the long text in details and a three-line Markdown
body are accepted, alongside the deliverable. The human reader shows exactly
those three, in order, and the delivered deliverable is read back in full.

The front's own 150-character cap is unchanged and covered by the front-flow
unit test, not by this daemon proof.
