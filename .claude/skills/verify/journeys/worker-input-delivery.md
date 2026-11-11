# Follow-ups wait for the worker turn to finish

Use SKILL.md's isolated proof wrapper with a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/worker-input-delivery.ts
```

The helper sends two ordinary notices through the daemon's registered work.send
operation to a busy synthetic HyperNeo session. It requires durable input rows,
parked jobs, retained message text and deferred deadlines, then restarts its own
daemon against that synthetic database. Once the worker becomes idle it observes
both messages, in order and once each, through the real SDK input reader and
retains the native adapter outcomes. It also recovers a persisted dispatch marker,
records its failure while the originating Neo is unavailable, then requires one
uncertainty report in that Neo’s SDK inbox after its receiver is created. It proves the uncertain text
stays retained while the worker receives no replay. The session uses manual query mode.
The wrapper removes the disposable HOME and database after saving observed.json.

Run worker-input-admission.test.ts and worker-input-delivery.test.ts on the test
host for question-stop answers, live human prompts, explicit steering, the four
local adapter status contracts, waiting for initial instruction binding,
transaction rollback and interrupted dispatch recovery. These adapter fixtures
use synthetic status and input receivers. The isolated daemon proof exercises
the HyperNeo receiving path. Installed Desktop clients and model turns require
their own native journeys.

Deferred adapter refusals, thrown transport errors and live-prompt refusals must
retain their failure outcome when notification fails. Their jobs wait for the
report receiver without consuming failure retries, and recovery sends one report
with no additional native submission. The fixture covers these failure paths.
