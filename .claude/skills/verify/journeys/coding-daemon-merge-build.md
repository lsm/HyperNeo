# Fresh facts and receipts for daemon merging (build)

Use shared guarded metadata-only setup in SKILL.md, with an absolute fresh evidence
folder and existing dependencies:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-daemon-merge-build.ts
```

The helper owns an isolated real daemon, synthetic HOME/database, an ephemeral
non-8399 listener and a refusing GitHub CLI fixture. No provider or external
HTTP is allowed. It sets only synthetic repository preferences through public
RPC and calls the coding pack's new fresh-facts reader and PR1 pure gate.
Paginated labels must include a human-merge label on a later page and require
human sign-off. A complete empty label list admits eligible facts. Required
checks, reviews, labels or thread read failures and a final moved head must
return unreadable facts. No todo or owner is needed.

Receipt commands run in the real DB writer. A held WAL lock must delay the
begin receipt while health remains responsive. After commit, executor, head
and start time are immutable; completion cannot be overwritten and pending
receipts cannot be acknowledged as notified. Restart preserves the completed
receipt; successful notification acknowledgement removes it from pending work.
Target receipt SQL must be zero on main. The helper closes both instances,
saves coding-daemon-merge-build.json and its gh read log; the wrapper removes
all synthetic daemon data after preserving evidence.

This is a build proof. The sweep and owner merge instructions remain unchanged,
no merge command is executed, and real merge delivery, GUI and deployment are
unverified. The activation slice must prove the actual sweep/merge/notification
path and uncertainty recovery. Repeat on Deno when installed; CI registers the
same helper in required Deno smoke.
