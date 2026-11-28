# Send to an Antigravity Desktop conversation

## Isolated daemon with a fake App

Run the isolated daemon with pinned Bun and a fresh evidence directory:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence \
  .claude/skills/verify/antigravity-desktop-send.ts
```

The proof sets up a synthetic catalog and a fake App: a local Connect server that the proof process owns, with a private `hub_<port>.json` advertisement. It checks:

- `work.adapters` lists `antigravity-desktop` with `find` only while no advertisement exists, and `work.send` is refused.
- With the advertisement present, the adapter offers `find` and `send`. `work.send` then calls `SendUserCascadeMessage` with the CSRF token, and the receipt's `inputId` is the sent `clientMessageId`.
- An unknown id is `not_found`.
- Removing the advertisement drops `send` again.

## Attended live check

This check needs Antigravity Desktop open and signed in, plus a disposable conversation you created for it:

```sh
bun .claude/skills/verify/antigravity-desktop-live.ts --attended CONVERSATION_ID /absolute/evidence
```

It drives the running App through the adapter with the real home directory. It checks:

- The adapter offers `find` and `send`.
- The conversation is in the App catalog.
- A send returns `delivered: true`, the App runs the message and replies.
- An unknown id is refused as `not_found` without sending.

The CSRF token is never printed. The evidence holds only step types, statuses and the first 80 characters of each step.
