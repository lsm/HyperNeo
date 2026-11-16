# Daemon notices are labelled synthetic in the session UI

Use the shared setup and resource check in SKILL.md. Build the web app first,
then run the metadata-only helper with installed Playwright on NODE_PATH and
an installed headless Chromium executable in VERIFY_BROWSER:

```bash
bash .claude/skills/verify/resource-check.sh && (cd packages/web && bun run build)
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<headless-chromium> \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/daemon-synthetic-inputs.ts verify
```

The helper owns an isolated daemon and static web listener on ephemeral ports,
a synthetic Neo binding and a fresh database. No model, provider, external MCP,
GitHub, simulator or human daemon is used. The job processor is stopped before
seeding, so no provider turns are attempted. The stalled-ask producer, the
attention entry, the digest hold, its timed flush, persistence, public message
reading and UI rendering use production code.

The real driver refresh raises one open ask that has had nothing in progress
for three hours. Require one pending `neo_notes` line and no session message
yet. Advance the helper's clock past the 15-minute hold and refresh again: the
production flush must release the line as one batch input with isSynthetic
true, queued for Neo's next turn. No turn runs here, so the helper stands in
for the provider's acknowledgement with the repository call the SDK handler
makes (`updateMessageStatus(..., 'consumed')`); that step alone is synthetic.

Pass: the actual served /session/neo:UUID page displays the released digest as
a synthetic card that names the ask and keeps a human input as a human bubble.
The card survives reload. Session routes use the literal colon, as the
production router expects; an encoded neo%3A path does not reach this surface.

Keep messages.json, browser.json, notices.png, notices-reloaded.png and the
wrapper log/status. The helper closes its browser, listeners, service and
daemon in finally; the shared wrapper saves evidence and removes the temporary
data. A finished ask's wake and a todo's own notes are not covered here: a
wake reaches the session only through a model turn.

Audit: mailbox admission (planMailboxAdmission/projectAdmissionMessage) derives
synthetic provenance for non-human daemon origins, including recovery, scheduled
inputs, clone briefs, external events, inbox transport facts and direct-task
kickoffs. Space injections, task-agent messages, ACP tool results, external-event
digests and worker batches already set the flag. Neo's record-only notice branch
is the direct-save exception: it must set the flag before saveUserMessage so
its immediately visible row matches the ordinary mailbox path. Do not rewrite
old transcript rows or classify real human inputs as synthetic.
