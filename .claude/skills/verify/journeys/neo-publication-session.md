# Publications carry an exact session to open

Use the metadata-only shared setup in SKILL.md. No provider, model or GUI is
needed. The helper owns a fresh HOME/data/DB, a refusing GitHub stub and an
ephemeral non-8399 daemon; worktrees are disabled and jobs stop before fixtures.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-session.ts
```

The real MCP publisher must reject an unknown session by id without saving.
Correcting the same requestId with an existing session must store and deliver
`session` through the human `neo.publication.read` RPC and actual web DTO parser;
retrying saves one row. `neo.conversation.read` also retains `publication.session`.
A recorded worker sender for every current input, all the same sender, fills the
field automatically. A mixed/unknown source or an idle turn leaves it absent.
No prompt text, session title or most-recent worker is used to choose a session.
Retrying the auto-filled send after the turn ends must retain its first stored
session and return created:false. Adapter not_found rejects an explicit id; an
unreachable/failed lookup returns session_lookup_failed and instructs a retry
with the unchanged requestId/session, never an invented replacement id.

Keep observed.json and proof.log. On the test-first commit the helper fails:
the publish input does not yet accept session. Resources close in finally and
the wrapper removes the disposable run. This is daemon/MCP/RPC wire proof only;
Open-session controls in web/iOS belong to their later PRs. After merge, read
system.build through the owner socket and confirm the running commit contains it.
