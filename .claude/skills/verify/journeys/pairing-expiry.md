## A waiting phone receives the expiry refusal

Build the web bundle as described in SKILL.md. Run with pinned Bun on PATH,
using free daemon and mock ports (never 8399 or 8499):

```bash
VERIFY_MOCK_PORT=19337 VERIFY_KEEP_RUN=1 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/pairing-expiry.sh 19336
```

The helper launches an isolated daemon, creates a synthetic two-way pairing
code through the owner RPC door, records the phone through POST /pair, then
shortens only that fixture's expiry in its isolated database. The held second
POST must return 401 code_expired, without issuing a credential. It saves
`evidence/pairing-expiry.txt` and stops both owned processes.

For the deterministic early-timer boundary, run the pairing `pair-waits-deadline`
and `pairing-long-poll` Vitest tests. The regression advances the timer while
the wall clock remains one millisecond before expiry: the phone must stay held
until the wall-clock deadline. This does not widen the pairing timeout.
