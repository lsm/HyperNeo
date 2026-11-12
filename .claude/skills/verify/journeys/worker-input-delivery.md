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

The helper also answers a real worker card through neo.question.answer while
that worker is busy. The route and todo stay held after daemon acceptance.
After native admission, the real driver refresh accepts the stored answer and
the SDK inbox contains it. Consumer regressions additionally cover definite
failure retries and uncertain-outcome reconciliation. Scheduled wakes advance
their source baseline once the daemon durably accepts their input, matching
the existing HyperNeo mailbox boundary. Native unconfirmed outcomes keep their
source baseline. The scheduler regression checks two later unchanged cadences
for each local Desktop adapter and requires no duplicate wake.

An unknown worker also keeps its input pending while the originating Neo receives
one waiting-reason notice. The proof restarts the isolated daemon and observes
continued waiting with one notice and no settled input outcome. Unit fixtures
cover unreachable and malformed status, notification recovery and later delivery.

Waiting inputs use the existing driver's 60-second refresh cadence. The synthetic
proof advances only its disposable job deadlines after fixture state changes.
Repeated attempts for one answer share a report identity, so a persistent refusal
leaves one blocked notice in Neo's inbox. The proof checks two refused attempts.

Steering remains immediate for its owning todo. The admission regression checks
that a worker running or queued on another todo retains the existing busy refusal.

Dispatcher contention uses a one-second retry and preserves the stored worker
wait reason. The concurrency regression blocks one worker's status read while
a second worker is claimed, then checks its pending job deadline and reason.

An exhausted worker-input job retains a failure outcome and re-enters the same
lane to deliver its notice. The proof rejects dispatch writes in its disposable
DB until real processor retries exhaust, then requires one Neo notice and zero
native submissions. The unit fixtures also cover interrupted dispatch and a
notification receiver that recovers later. Unbound follow-ups report their reason
once after one minute while preserving the input for a later binding.

Space tasks retain their direct continuation send while running. The regression
uses a synthetic Space adapter and checks pre-start start/send targets preserve
their existing not_started result.

A raw send naming an unstarted todo first records its send target through queueOn.
The initial-todo scheduler dispatches its instruction and binds the todo. If the
new message supplies that instruction, its input retains the scheduler's native
outcome. A separate follow-up waits behind an existing instruction. The daemon
proof observes one initial message and the bound doing todo through this path.

Report identities include the failure text for a submission. Repeated identical
refusals share one notice, and a changed reason receives its own notice. The proof
changes the synthetic retired worker from missing to archived with the same answer
key and requires both reasons in Neo's inbox with all attempts settled.
