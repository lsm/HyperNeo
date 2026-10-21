### Goal-cycle prompt delivery (P1)

Run the existing real SDK/publication journey with a clean synthetic HOME and a
loopback scripted model using the repeatable wrapper:

```bash
bash .claude/skills/verify/neo-goal-cycle-sdk.sh /absolute/fresh/run-dir
```

The wrapper refuses an existing run directory and clears the parent environment.
It creates its own HOME/tmp, places the GitHub stub first on PATH, and invokes the
focused online test. Both the daemon and scripted model use ephemeral loopback
ports; it uses no real keys, provider account, live DB or GUI. Its synthetic model
credentials point only at that in-process fixture. The test closes the transport,
daemon and fixture in finally.

`evidence/neo-goal-cycle-sdk.json` records the actual model-facing system prompt,
human input, tool receipts and the publication read back through RPC. The prompt
must include the core goal cycle (goal/facts/mandate reads, journal runId,
progress updates, human path/hash confirmation and the scheduled-only one-line
ending), even with coding guidance present. Focused unit contracts cover domain
packs disabled too, and keep NEO_ROOT_PROMPT under 160 words and unchanged.

The scripted model proves prompt delivery and publication plumbing; it does not
prove that an autonomous model follows the cycle, that it writes a correct
journal/mandate, or that a goal wake renders correctly. Those behaviors are not
claimed by this prompt-only check. On the test-only commit, the same wrapper in
another fresh run records the missing guidance before failing its delivery
assertions. Preserve both JSON files outside the run directory.
