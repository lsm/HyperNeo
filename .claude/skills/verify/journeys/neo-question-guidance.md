# Concise Neo question guidance

From the worktree root, build web and use Launch in the verify skill with a fresh
synthetic run directory and free non-8399 port. In the same shell with a stop.sh
EXIT trap, run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-question-guidance.mjs 9381 "$RUN"
```

Set VERIFY_BROWSER to an installed Chromium executable if needed. The helper
records the assembled Neo prompt and the daemon's actual neo.question.ask tool
description. It seeds only a synthetic ask, creates the shared bullet/table
fixtures through neo.question.ask RPC, then drives the real built /neo page at
1280 and 390 pixels. Each card must show its short title, emphasized choice,
expected bullets or table rows, and usable answer buttons within the viewport.
It waits for the mobile sheet to settle. Both screenshots precede any answer.
On mobile it clicks the bullet card's choice and checks that answer in Details.
Evidence: evidence/neo-question-guidance.json and screenshots at both widths.
The fixture also runs through the real renderer in NeoAskTodos.test.tsx.

No model/provider calls, credentials, live DB, desktop GUI or port 8399 are used.
This verifies delivered guidance and guidance-shaped question rendering, not a
live model's likelihood of following the guidance. Stop daemon/mock via stop.sh.

Answering can queue a follow-up turn; with no provider configured it may produce
an expected provider/kickoff notification. This is not model execution proof.

Question fixtures carry an explicit core evidence retirement check inside the
synthetic run. That file stays absent during rendering and answering checks.
