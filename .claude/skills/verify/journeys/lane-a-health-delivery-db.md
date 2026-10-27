# Coding health delivery lookup on the DB gateway

Use the shared resource guard and isolation setup in SKILL.md. Run heavy jobs serially.

```sh
python3 .claude/skills/verify/lane-a-health-delivery-run.py bun verify
python3 .claude/skills/verify/lane-a-health-delivery-run.py deno verify --executable "$DENO"
```

DENO names an existing runtime with cached dependencies. Each run owns a fresh
synthetic HOME/data/TMPDIR and ephemeral non-8399 daemon. HTTP is refused and gh
is a refusing stub. The runner saves evidence before removing temporary daemon
data. The historical before mode targeted the pre-gateway implementation and is not
a baseline against already migrated dev. The reader-lane regression and its
current baseline commands live in lane-a-health-reader-db.md. The original
guarded-main failure remains committed in the original PR history.

Real persisted jobs invoke the production deliverCodingHealth pipeline. A
synthetic keyed receiver refuses the incident, then a recovery is recorded.
Restart retains both notices. A trigger rejects acknowledgement after the
receiver accepts: the job fails and health remains unchanged. Removing the
trigger and retrying concurrent delivery calls must preserve the receiver's
original key/body, admit only one acknowledgement per notice, and eventually
accept both notices. Later jobs and another restart must not resend.

The complete health and alias lookup runs as a reader snapshot before the
external effect. The original historical proofs used the serialized writer;
lane-a-health-reader-db.md verifies that it no longer reserves the writer. Its
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

The original PR bound its historical passing runtime pair to its committed
application/helper tree; that audit applies to that PR revision, not later
application changes. The current reader-lane binding is in the new journey:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-health-delivery-proof-binding.ts HEAD
```

Only this journey and its evidence directory may change after the bound proof
commit; application or helper changes require fresh runs on a new commit.
