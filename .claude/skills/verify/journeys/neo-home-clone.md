# Second-machine Neo home clone

Run from the worktree root with fresh absolute synthetic directories:

```bash
bash .claude/skills/verify/neo-home-clone.sh "$RUN"
bash .claude/skills/verify/neo-home-clone.sh "$MISSING_RUN" missing
```

The helper creates a first-machine Git repository and a local bare remote, then
starts an isolated test daemon on an ephemeral loopback port. It uses the actual
`operation.invoke` WebSocket door as the local human. No GitHub repository, real
credentials, live data, model provider, GUI or port 8399 is used. GitHub is stubbed;
HOME and Git configuration are synthetic, with system configuration disabled.

`neo.home.init {remoteUrl}` must clone the shared history into the second machine's
home, retain its private coordinator transcript, and configure origin/upstream.
Repeating that choice must leave HEAD unchanged. Reading direction must return
the first machine's exact content. Saving an ordinary note must push the new
commit to the same local remote. The missing-remote mode must refuse with
`clone_failed` and leave only the original coordinator directory.

`evidence/neo-home-clone.json` is written even on assertion failure. The helper
closes its transport and daemon in `finally`. The pre-fix RPC instead returned
success with an empty direction and no origin; this is not a passing clone.

Run the focused `neo-home-clone.test.ts` contracts plus the existing home suites.
They cover human-only remote selection, same-choice reuse, refusal of a different
origin or existing documents, empty/inaccessible remotes, exact relative symlinks,
remote transcript refusal, and a human file arriving during clone. The latter
must retain that file and remove only the files the failed publication created.
No real remote networking or process-kill recovery is proven by this journey.
