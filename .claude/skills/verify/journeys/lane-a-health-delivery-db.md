# Coding health delivery lookup on the DB gateway

Use the shared resource guard and isolation setup in SKILL.md. Run heavy jobs serially.

```sh
python3 .claude/skills/verify/lane-a-health-delivery-run.py bun before
python3 .claude/skills/verify/lane-a-health-delivery-run.py bun verify
python3 .claude/skills/verify/lane-a-health-delivery-run.py deno verify --executable "$DENO"
```

DENO names an existing runtime with cached dependencies. Each run owns a fresh
synthetic HOME/data/TMPDIR and ephemeral non-8399 daemon. HTTP is refused and gh
is a refusing stub. The runner saves evidence before removing temporary daemon
data. Before mode temporarily restores health-delivery.ts from origin/dev and
restores the draft in finally; do not edit concurrently. The failing guarded-main
regression must be committed before implementation.

Real persisted jobs invoke the production deliverCodingHealth pipeline. A
synthetic keyed receiver refuses the incident, then a recovery is recorded.
Restart retains both notices. A trigger rejects acknowledgement after the
receiver accepts: the job fails and health remains unchanged. Removing the
trigger and retrying concurrent delivery calls must preserve the receiver's
original key/body, admit only one acknowledgement per notice, and eventually
accept both notices. Later jobs and another restart must not resend.

The complete health and alias lookup now runs in the existing serialized ledger
writer command, providing a committed snapshot before the external effect. Its
existing acknowledgement is another guarded writer command, after receiver
acceptance. No transaction spans the notification. This does not claim exactly-once
external notification across a lost response; stable keys retain current retry
behaviour. Unit contracts retain ordering and current-health preservation.

During delivery jobs, instrument pack_coding_repo_health and
pack_coding_repo_aliases on the main connection. Fixtures and assertion queries
are excluded. Baseline requires target SQL; fixed runs require zero. Command
duration and argument/reply sizes are retained without separate queue, clone
or SQL attribution. This proves job delivery with a synthetic receiver, not an
actual Neo mailbox, recipient consumption, a full coding sweep, GUI, GitHub,
provider turn, whole-daemon SQL absence or a latency target.

Bind both passing runtime runs to one committed application/helper tree:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-health-delivery-proof-binding.ts HEAD
```

Only this journey and its evidence directory may change after the bound proof
commit; application or helper changes require fresh runs on a new commit.
