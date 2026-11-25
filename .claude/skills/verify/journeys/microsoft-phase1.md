# Complete the Microsoft phase-1 flow

```sh
bash .claude/skills/verify/microsoft-phase1.sh "$EVIDENCE"
```

Runs every Microsoft daemon proof in order, each in its own fresh isolated run
through `proof-run.sh`, and stops at the first failure:

1. [Sign-in](microsoft-sign-in.md): consent, PKCE, ID-token checks, account
   mismatch, Google and Microsoft disconnect kept apart.
2. [Refresh](microsoft-refresh.md): single flight, rotation across a restart,
   `invalid_grant` shows Reconnect needed with no retry loop.
3. [Mail](outlook-mail.md): bounded search and thread read, signed cursors,
   per-message body cap.
4. [Drafts](outlook-draft.md): create, update, non-draft refused, zero sends.
5. [Calendar](outlook-calendar.md): windows, all-day dates, each event's own
   time zones, zero writes.

Each step's evidence lands in `$EVIDENCE/<step>/`. The run prints each step's
`PASS:` line, then a final one. For the Settings UI, also run
[the Microsoft Connections journey](microsoft-connections-settings.md); it needs
a browser. All endpoints are synthetic: this proves daemon control flow, not
real Microsoft interoperability, which needs the human's own app registration
and one real-account check.
