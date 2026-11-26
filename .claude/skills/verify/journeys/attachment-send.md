# Sending staged attachments

Run this journey on the candidate tree using Bun 1.4.4 and the shared
isolation and cleanup in SKILL.md. The daemon online CI suite runs the same
helper in `attachment-send.test.ts`.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/attachment-send.ts "$(git rev-parse HEAD)"
```

The helper pairs a synthetic phone, stages photos through the paired PUT and
sends over the paired socket. For `neo.message.send` the receipt shows a
photo-only send with both thumbnails, a mixed send whose images keep their
order, a refusal for an unstaged hash, an inline send, and a replay of an
accepted request after its staged file is deleted. The legacy work-chat
`message.send` shows the same photo-only, missing-file and order checks. In
both routes six mixed blocks are accepted, and seven blocks (with a repeated
hash, or seven unstaged hashes) are refused with the six-image reason before
any file read or persistence. Seven inline images still reach work chat.
Require wrapper exit zero and retain `attachment-send.json` and
`run-status.json`.
