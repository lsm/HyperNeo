# Fresh facts and receipts for daemon merging (build)

Use shared guarded metadata-only setup in SKILL.md, with an absolute fresh evidence
folder and existing dependencies:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-daemon-merge-build.ts
```

The helper owns an isolated real daemon, synthetic HOME/database, an ephemeral
non-8399 listener and a refusing GitHub CLI fixture. The CLI fixture uses Bun
from PATH even when the daemon proof runs on Deno. No provider or external
HTTP is allowed. It sets only synthetic repository preferences through public
RPC and calls the coding pack's new fresh-facts reader and PR1 pure gate.
Paginated labels must include a human-merge label on a later page and require
human sign-off. A complete empty label list admits eligible facts. Required
checks, reviews, labels or thread read failures and a final moved head must
return unreadable facts. A delayed initial PR read exposes an old-head CI race:
the checks fixture is green before the new head is observed and pending after.
The reader must observe the head before requesting CI, then re-read the head
after all facts; it must never attach those old passing checks to the new head.
The failing real-daemon reproduction is committed before this ordering fix.
Read failures must also include a readable explanation and safe next step; the
helper tests malformed GitHub replies and a synthetic reader exception. These
pack-local messages must pass the existing refusal-catalog audit without adding
coding-specific entries to core. No todo or owner is needed. A mixed-case GitHub hostname must work without
GH_HOST; the CLI fixture also refuses unnormalized --hostname values. The
hostname regression is reproduced through this daemon helper before the fix.

Receipt commands run in the real DB writer. A held WAL lock must delay the
begin receipt while health remains responsive. After commit, executor, head
and start time are immutable; completion cannot be overwritten and pending
receipts cannot be acknowledged as notified. Restart preserves the completed
receipt; successful notification acknowledgement removes it from pending work.
Target receipt and failure-budget SQL must be zero on main. Synthetic failed
attempts release their receipts while preserving the failure budget. Restart
must preserve two failures and their error; the third consumes the remaining
budget and another begin must be refused. An uncertain CLI error must retain its
receipt/error across restart without consuming budget, then count once when
promoted to a confirmed OPEN failure. The helper closes both instances,
saves coding-daemon-merge-build.json and its gh read log; the wrapper removes
all synthetic daemon data after preserving evidence.

This helper proves fact reads and writer durability; it executes no merge
command. The separate coding-daemon-merge-sweep journey proves execution,
retry and confirmation behavior. Real merge delivery, GUI and deployment are
unverified here. Repeat on Deno when installed; CI registers the
same helper in required Deno smoke.
