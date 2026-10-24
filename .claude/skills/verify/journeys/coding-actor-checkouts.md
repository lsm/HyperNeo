# Exact-head actor checkout preparation (Build)

Read shared isolation rules in `../SKILL.md`. This helper exercises the production
coding checkout-preparation API with real Git and only fresh synthetic repositories
under its run directory. No daemon, provider, HTTP mock, credentials, GitHub,
browser or reserved port is needed. Git's global/system config and hooks are
disabled for fixture commands. It never uses the human's checkout or home data.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-actor-checkouts-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/coding-actor-checkouts.ts "$RUN"
```

Observe `evidence/actor-checkouts.json`: Review and Verify each prepare the literal
PR head from `refs/pull/7/head`, which differs from the base branch, while preserving
the source's older HEAD and dirty file. Actual Git status remains clean because
the complete trusted role contract lives in the clone's Git directory. Evidence
records its byte count and SHA-256 (both contracts exceed the work-start message
limit) rather than truncating it into a kickoff message. Verify retains the shared
contract plus a two-sentence override applying only to coding-pack Verify runs:
head-only validation, CI for base integration, and a new head reruns Verify.
Ordinary preparation still uses the base and writes no role contract.

A moved PR ref refuses before creating a worker checkout. Each successful clone
is released in finally, and the helper asserts the owned directory is gone.
Fixture repositories and evidence remain in the run directory for inspection;
there are no background processes to stop. Existing `neo-coding-preparation`
tests also cover malformed pins, default preparations and cleanup failure paths.

Not verified: public actor-assignment RPC, starting native harnesses, model turns,
role-contract compliance by a model or merge/completion gates. This Build slice
prepares the runtime checkout surface; final #8428 wiring will drive it through
the actual assignment operation and extend verification for dispatch.
