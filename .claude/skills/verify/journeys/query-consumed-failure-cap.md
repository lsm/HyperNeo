# Consumed prompts reach the shared query-failure cap

Use SKILL.md isolation and resource checks. No model listener or port 8000
preflight is needed. The native helper uses the real SDK transport with a
deliberately silent, owned child process through `spawnClaudeCodeProcess`.
No SDK module is mocked. It disables the SDK sandbox only for this synthetic
transport proof; this does not verify OS sandbox enforcement. External HTTP
is refused, titles and registry MCP servers are disabled, and the only provider
credential is synthetic and stored in the disposable DB.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/query-consumed-failure-cap.ts native
```

Before the fix the real message.send delivery is consumed, startup attempts stop
at two, and public metadata remains failures=2/failed=false beyond the two-second
shared admission delay. The fixed run must start exactly three native processes,
observe at least one- and two-second retry delays, and expose a persisted failed
episode and terminal session.error containing the original startup timeout.
The original user message remains delivered, with no fourth start after the cap.

Repeat with `interrupt` and `reset` in separate evidence directories. Both act
through the public RPC during the second backoff and must prevent a third start;
reset must change the episode ID and leave its count at zero. Keep the JSON,
proof.log and wrapper exit status. The helper closes its daemon, socket and all
owned children; the wrapper saves evidence before deleting temporary data.

For a cause-independent error after prompt consumption, run the existing helper
with `consumed` and `consumed-init`; their scripted iterators consume the real queue input before
throwing an arbitrary error, before or after SDK initialization. Require the same cap, delivered message, stable
persisted episode, no fourth start, and successful explicit reset after fixing
the scripted cause. The after-init fixture deliberately has no SDK transcript,
so recovery accepts the public start-fresh choice rather than bypassing resume
validation. `consumed-handoff` checks an accepted rate-limit handoff stays
with that owner rather than being retried by the terminal fallback.

Run the existing retry ownership and routing suites too. They preserve accepted
handoffs, turn-ended no-ops, queue stop, replacement generation, interrupt and
cleanup decisions. Those characterization tests isolate the governor and do not
replace the two real-daemon proofs above. The durable work.status and Neo wake
consumer is separately verified in #9110; public failure metadata alone does
not prove that consumer. Deployment smoke is applicable after merge: read the
served build without restarting or mutating the live daemon and report a pending
owner rollout if the served build does not contain the squash.

The online regression uses the same silent-process seam. Run its scrubbed fixture:

```sh
python3 .claude/skills/verify/startup-timeout-fixture.py "$ONLINE_EVIDENCE"
```

It owns a mock-model listener on an ephemeral port for provider discovery; the
session SDK process stays silent. Require the Vitest test and wrapper exit zero,
with no extra retries or children left running. The fixture saves the test log
and cleanup receipt outside its disposable HOME/data before deleting that data.

After the paired consumer has landed, also run `query-failure-governor.ts
consumed-consumer` with the shared wrapper. It consumes the worker prompt before
throwing the arbitrary error and saturates the recoverable error throttle. Require
three attempts, public work.status=failed with the original error, one durable
Neo input, exactly one recipient SDK start, and no second wake after recovery.
This combines the consumed-input producer with the real landed consumer. It
keeps the native silent-process proof separate from the scripted model proof.

The scripted helper joins its owned query and already-scheduled deferred replay
promise before closing the synthetic DB; it does not change production replay
policy. Audit the complete proof.log after the wrapper exits. A closed-database
error invalidates the run even if its assertions or wrapper exit report success.
Keep that failed log, fix fixture resource ordering, and rerun before reporting PASS.
