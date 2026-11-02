# Publication Open targets in the wire response

Use shared isolated setup and the resource guard in SKILL.md. No model, browser,
native app or real account is needed for this metadata contract. Run:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/publication-open-target.ts after
```

The helper owns an ephemeral real daemon, fresh HOME/data and a refusing GitHub
stub. Only work.find/work.status metadata for synthetic native sessions is scripted;
publication MCP admission/writes and both client WebSocket read doors are real.
The signed failing regression shows a successful publication whose response lacks
its Open target. After the fix, `sessionSource` carries the existing work-card
source shape (id, adapter, name, label, provider, link, optional daemon).

Check qualified and exact bare Codex IDs, local/Neo/Space sessions, Claude,
linkless/unsafe native links, ambiguous IDs, unavailable lookup, input injection,
idempotent retries and edit history. Old `session` values stay unchanged. Both
neo.publication.read and neo.conversation.read carry targets, including revisions;
repeated sessions share a page-local lookup. No source metadata is persisted in
publication payloads. Require wrapper exit zero and resourcesClosed true.

Run the publication/session-source/conversation operation suites and repo checks.
This additive optional field uses the existing wire protocol version; clients may
prefer it while retaining their old-daemon fallback. A missing session has no
field; a known publication whose session cannot currently resolve has null.
Known sessions without a safe app URL retain their source with link:null.

After daemon merge/deploy, read owner build/PID/health and rerun this proof from
the merged commit. Ask the coordinator to publish one new reply pointing at a
known Codex thread, then read its sessionSource fields through the normal
publication/conversation operation and compare with neo.session.link. Never read
credentials or borrow a paired-human login. Report actual live fields and build,
then stop all owned test resources and remove the PR worktree.
