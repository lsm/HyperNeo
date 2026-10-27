# Workflow identity updates preserve their RPC contract during extraction

This is a neutral extraction before the writer build/wiring slices. Workflow
metadata SQL still executes on main; this journey makes no migration or latency
claim. The contract was committed before moving the field builder and is run
unchanged on the baseline and extracted code.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/identity-evidence \
  .claude/skills/verify/workflow-identity-contract.ts verify
```

A fresh synthetic daemon serves real `spaceWorkflow.update` and
`spaceWorkflow.get` RPCs. Rename trimming, a complete Unicode description,
start/end-node changes and ordered tags must survive the update. Clearing a
nullable description and tags must preserve the omitted name and endpoints.
The same node definitions must remain, timestamps must advance and the immutable
version payload must match the returned workflow's SHA-256 hash.

Evidence records the actual requests/replies and metadata SQL. Run baseline and
after in separate fresh directories. Repeat with `VERIFY_PROOF_RUNTIME=deno` and
supported Deno on PATH. The wrapper retains evidence and removes synthetic data.
No model turn, provider, GUI or live database is involved. The extracted builder
contains only identity-field assembly; SQL, validation and notifications remain
in their existing paths until later slices.
