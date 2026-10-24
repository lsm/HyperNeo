### Policy-aware merge nudges (slice 3)

```bash
RUN=$(mktemp -d /private/tmp/hn-policy-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-policy.ts verify 9353 "$RUN"
```

On the reproduction commit run `reproduce` in another fresh directory: a scripted
bot approval for synthetic qlark#19 leads to merge text immediately and again at
+20 minutes. Fixed code must emit zero merge messages and show `waiting_human`
through the real daemon's `neo.snapshot` and production coding-pack sweep/events.
Settings are written only to the synthetic daemon through the human RPC door.
GitHub reads and message delivery use synthetic fixtures/capture sinks; the
production classification, repositories, event delivery decisions and sweep run
unchanged. Both daemon and socket close in `finally`. Evidence retains every
state and emitted message in `evidence/observed.json`. No credentials, provider,
model, live DB, real GitHub calls or GUI are used.

Configured humanSignoff globs apply to changed paths: this design PR stays in
`waiting_human`; code-only PRs can become merge-ready. Missing or incomplete file
lists keep signoff pending. See `coding-signoff-scope.md` for code-only approval
and terminal owner-mailbox delivery. Review-author login enforces designated-bot
approval; unknown/stale authors never count. This journey proves the nudge
decision and snapshot, not live GitHub transport or worker consumption.
