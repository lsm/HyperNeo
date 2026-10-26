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
human input, tool receipts and the publication read back through RPC. The ordinary model-facing system prompt
must include standing-outcome setup (home init, human-bound mandate save and an
explicit 15-minute/nudgeEvery1-2 goal), but must not include the full scheduled
goal-cycle instructions. The cycle now travels only in the goal wake content;
run journey 27 for the real scheduled delivery. Focused contracts cover packs
both enabled and disabled, reminders remaining unchanged and the exact run id.
The root remains under 300 words, including the setup entry point and the
home-editing instruction. Run the focused prompt contracts against the PR merge
tree too: changes on dev count toward the same budget.

The scripted model proves prompt delivery and publication plumbing; it does not
prove that an autonomous model follows the cycle, that it writes a correct
journal/mandate, or that a goal wake renders correctly. Those behaviors are not
claimed by this prompt-only check. On the test-only commit, the same wrapper in
another fresh run records the old always-on system cycle before failing its
separation assertion. Preserve both JSON files outside the run directory.
