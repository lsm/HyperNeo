### Home proposal questions (journey 37)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-question-confirmation.ts <port> "$RUN" after`.
The helper opens only a synthetic Neo session and seeds its own ask in its test
DB, then uses real `neo.question.ask`, `get` and local-human `answer` RPCs.
A yes/no proposal must retain `confirm:{path,sha256}` through creation and the
human answer. The visible body must include that exact path/hash; an incomplete
body is refused. Ordinary questions remain unbound. A protected `neo.home.save` without a question remains `confirmation_required`;
journey 38 exercises confirmed saves and the paired decision commit.

Evidence: `evidence/neo-question-confirmation-after.json`. Stop the daemon/mock,
restart only that same synthetic run, and run the helper with `restart`: its
saved question must retain the exact binding, answered state and human yes.
No provider/model, real credentials, GitHub requests or GUI are needed; a delivered
answer note may queue a turn with no provider, which is not model-execution proof.

For the upgrade reproduction, start on the contract-test commit before the
migration and use `before`. It records the old ask/get dropping metadata and
saves a legacy question id. After stopping those processes, boot the fixed code
against only that same owned synthetic DB and run `after`, then `restart`.
The legacy text/answer stays intact with a null binding; new proposals persist.
Repeat with `boundaries` to check that a path shown only as a longer filename or
inside another path, and a hash shown only in a longer hex string, are refused.
Exact path/hash tokens surrounded by Markdown/prose punctuation must be accepted,
including balanced italic, bold and strike markers; underscore filename suffixes
remain near misses.
`evidence/neo-question-confirmation-boundaries.json` retains every response.
The additive/idempotent legacy-answer migration contract runs in CI.
Never copy or alter a real DB for this journey. Stop with `stop.sh` afterwards.
