# Every Neo reply body stays short

Read shared setup in SKILL.md. This uses the actual daemon, the Neo MCP operation
handler and the human RPC reader, with no model subprocess:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-body-limit.ts
```

The body limit is about 60 words or 150 Chinese characters, at most 500
characters, and at most 5 non-empty lines including the title. It applies with or without details.

Neo publishes five bodies over the limit: 61 words alone, a six-line list, 151
Chinese characters, a short label with a 500-character base64 string, and 61
words with longer details. The first four are
refused as `reply_needs_details` with the explained reason ending "the rest in
details"; the fifth as `reply_summary_too_long` with "shrink text". The reader
then has no publication. A one-sentence summary with the long text in details
and a three-line Markdown body are accepted, and the reader shows exactly those
two, in order.

The front's `reply` tool runs the same check; its refusal is covered by the
front-flow unit test, not by this daemon proof. On the test-first commit this
helper fails because the long bodies are accepted.
