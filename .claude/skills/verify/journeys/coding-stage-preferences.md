# Unified Write, Review and Verify target preferences

Read shared isolation setup in `../SKILL.md` and `core-pack-preferences-slice-1.md`.
This Build slice adds nine human-owned settings and a read-only Write target
planner. The helper starts its own real daemon twice on ephemeral loopback ports
with a fresh synthetic DB/home; no model, provider, HTTP mock, GitHub or browser
is needed. It refuses HTTP and stops both owned daemon instances in finally.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-stage-preferences-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-stage-preferences.ts "$RUN"
```

Actual WebSocket RPC `neo.coding.write.plan` returns the first supplied available
configuration while unanswered settings remain unsaved. Human RPC
`pack.preferences.set` sets preferred harness/model/effort for all three stages.
The planner selects the preferred Write configuration, explains unavailable
values and rejects invalid types/oversized text. After restarting the daemon,
all nine settings retain human provenance, the preferred plan stays selected,
and a default-only candidate list returns all three fallback explanations.
An unanswered second repository still uses its default without saved values.
Retain `evidence/stage-preferences.json` with the real requests and replies.

Focused `neo-coding-stage-preferences` tests additionally exercise the shared
Review/Verify selector: provenance filters before preferences, a different
harness breaks otherwise equal reviewer ties, same-model and missing-provenance
reviewers refuse, disabling provenance works, and repository/global precedence
is preserved. These selector tests are not live session proof.

Not verified here: native harness/model availability, starting a Write session,
Review/Verify session dispatch, bot ingestion or merge/completion gates. Available
candidate configurations are inputs, not a probe of installed providers. The
following actor-assignment slice consumes the shared selector; no second workflow
engine or scheduler is introduced.
