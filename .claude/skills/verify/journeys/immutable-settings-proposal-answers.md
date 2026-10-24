### Immutable settings proposal answers

```bash
RUN=$(mktemp -d /private/tmp/hn-preference-answers-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-preference-answers.ts 9354 "$RUN"
```

The helper uses the real daemon registry's MCP and WebSocket operation doors.
A declined question returns `question_closed` when retried with the same request id;
a new request id must reach the human as an open question.
Neo proposes two synthetic settings; the daemon generates the exact question
text, and `neo.snapshot` must expose that question. Before consent the settings
remain unanswered; the separately initialized empty Coding watch list is excluded
from these review-policy assertions. Agent answering is refused; the human button's real
`neo.question.answer` path must atomically apply the stored values. Across daemon
restart, `neo.question.get` reports human consent, provenance stays human, and
agent attempts to replace values or reuse a request id with a different proposal
are refused. A questionId-only retry leaves settings unchanged. Complete replies
are retained in `evidence/observed.json`; both daemons close in `finally`.

No legacy binding, live database, provider, credentials, model or GUI is used.
The ordinary human-answer notification may queue without a provider; this journey
proves question/setting persistence and caller boundaries, not notification/model
completion. Unit contracts also inject a failing settings write and require both
consent and every value to roll back together. Actual browser rendering and the
future first-dispatch trigger are not verified here.

Before pushing a new numbered migration, run from the developer checkout:
`bun .claude/skills/verify/migration-number.ts <number> [own-pr-number]`.
This read-only preflight fetches fresh dev and enumerates every open PR's changed
files through `gh`, then asserts a new candidate follows the highest numbered
migration. A number already reserved in own-pr-number is checked for collisions
instead. Supply own-pr-number only when updating that same PR. It uses GitHub,
not the isolated daemon or a live database; do not run it under the stub-gh PATH.
Unpublished reservations still need coordination with their owner.
