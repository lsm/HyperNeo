# Neo primary restoration preserves the fallback pair on refusal

From the worktree root, use a fresh, nonexistent absolute run directory:

```bash
bash .claude/skills/verify/neo-model-alignment.sh /private/tmp/hn-neo-alignment-UNIQUE
```

The wrapper starts the real daemon and SDK under the online Vitest runner, with
NODE_ENV=test, fresh HOME/data/SQLite/SDK transcript directories and ephemeral
loopback ports. The only model traffic goes to a local scripted Anthropic-shaped
server; GLM discovery/probe calls also use this fixture. Keys are synthetic,
GitHub is stubbed, and no real provider, credential file, live DB, GUI or port
8399 is used. Every fixture closes its SDK, client, daemon and model server.

A human saves an Anthropic primary at think24k and a GLM fallback at think8k
through the real operation door, then sends a human message. The primary's
synthetic billing refusal triggers the actual recovery path; the fallback must
publish the answer with its 8k budget. Once the fallback starts answering, the
fixture removes the primary from the provider registry and available catalog.
This makes the real ModelSwitchHandler refuse restoration at the idle boundary.
The live session and stored config must both remain GLM/think8k. A second human
message must finish on that fallback with the same low/8k thinking, while the
saved human preference still names the unavailable primary and its 24k thinking.

Before the fix, the first idle boundary persists GLM/think24k and this journey
fails. Evidence remains in evidence/neo-model-fallback-glm-refused.json even on
failure. The two original successful-restoration cases also run unchanged:
Anthropic and GLM fallback inputs finish, then a restored primary handles the next
human input at high/24k thinking. Keep their separate evidence JSON files and
runner output. These are real SDK/daemon receipts against a synthetic local
provider; they do not establish a real account's model availability or UI rendering.

The focused neo-model-preference unit suite additionally covers refused and
throwing switches restoring the previous thinking, and the existing success/recovery path.

Restoration keeps the original pre-switch thinking preparation: the model switch
may restart a query before returning, so moving the update after it regresses the
existing high-effort restoration cases. Refused or throwing switches roll that
preparation back before alignment settles; successful switches keep the prepared
primary thinking. The journey checks actual outgoing effort, not only final config.

## Deferred switch receipt

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-pending-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/neo-pending-alignment.ts "$RUN"
```

This separate isolated-daemon check uses the real operation door, session manager,
AgentSession switch queue and model-switch handler. It marks only the synthetic
session's processing state busy through its state manager, without starting an SDK
query. Saving primary/24k through RPC must return success with an actual pending
switch while both live and stored config stay GLM/8k. Remove the synthetic primary
from the catalog, then let the real idle callback consume and refuse that pending
switch: GLM/8k must remain and pending metadata must clear. The three SDK journeys
above verify successful restoration separately. observed.json keeps receipts,
state and health; the helper closes its client and daemon. It stubs GitHub and
uses no provider keys or network model calls. This proves real queued-switch
application/refusal under synthetic busy state, not an in-flight SDK race. The
three SDK journeys above retain the actual outgoing effort checks.

On the review regression commit, this door check fails before idle: the real
success/pending receipt leaves fallback/24k. The unit receipt regression also
fails there; after the correction it covers pending, later refusal and a later
successful restoration. Pending is acceptance of a future switch, never evidence
that the primary is already restored.
