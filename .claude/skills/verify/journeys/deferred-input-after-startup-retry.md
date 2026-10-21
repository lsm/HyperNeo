## A deferred follow-up runs after a cold-start retry

Set `PROOF=.claude/skills/verify/deferred-startup-retry.ts` and use the
**In-process RPC proofs** setup in SKILL.md, adding
`HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS=15000` to the isolated environment.
Ports 8000 and 8001 must be free.

The helper creates a synthetic session through RPC and sends a kickoff input.
Its first subprocess fixture accepts SDK transport input but emits no messages,
deterministically exercising startup timeout. All subsequent subprocesses use
the installed SDK executable. A transparent stdin tee records the attempt and
input UUID, without replacing the SDK transport. The model API stays local.

After the first subprocess receives kickoff, the helper sends a deferred
follow-up through `message.send`. It must appear as deferred while busy. The
replacement subprocess must receive kickoff itself; delivery to the closed
subprocess cannot satisfy the assertion. Both markers must reach actual mock
model requests, with two consumed inputs and zero remaining deferred inputs,
without an interrupt or extra send to advance the queue.

Evidence: `$RUN/evidence/deferred-retry.json` contains RPC counts, subprocess
input receipts and mock-model marker observations. Resources close in finally.
Credentials are stored through provider RPC only in the synthetic DB. GitHub
is stubbed. Browser rendering and real provider traffic are not exercised.

The regression in #8071 starts its deferred-drain deadline on an intermediate
retry idle. A blocked old input stream can steal the retried kickoff, leaving
the replacement SDK silent through a second startup timeout. This proof
requires the replacement to receive the input before any terminal recovery
can start a third subprocess.

Reproduction commit `3d746f55d` fails the unit assertion with recipient
`closed SDK` rather than `replacement SDK`. Its RPC proof fails with
`replacement SDK never received the retry input`; the second subprocess has
only control requests. After the fix, attempt 2 receives kickoff and the
deferred follow-up, and both markers reach the model with final counts
`consumed=2`, `deferred=0`. The original online case and its timeouts stay intact.
