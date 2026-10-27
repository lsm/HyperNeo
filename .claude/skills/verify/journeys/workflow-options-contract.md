# Workflow option patches retain their RPC behavior

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/workflow-options-evidence \
  .claude/skills/verify/workflow-options-contract.ts verify
```

This neutral extraction proof starts a fresh synthetic daemon and exercises
spaceWorkflow.update/get through real WebSocket RPC. It retains channels, hook
configuration, layout, template identity, full Unicode instructions, completion
autonomy, post-approval routing, disabled state and handle. Omitted options stay
unchanged, nullable clears retain their existing meaning, and disabled false/null
remain distinct. Nodes and immutable definition-version payload/hash survive.

Run and commit this characterization before extracting the SQL patch builder;
repeat it unchanged afterward and under supported Deno using
VERIFY_PROOF_RUNTIME=deno. Evidence records the main-connection UPDATEs and their
SQL hash for comparison. This rung intentionally leaves those statements on
main: it establishes behavior for the later writer build/wiring, and is not a
write migration. Hooks are stored only; no script or model turn executes.

Run workflow-manager and workflow repository option suites. Shared setup and
cleanup stay in SKILL.md and proof-run.sh; the helper preserves its RPC evidence.
