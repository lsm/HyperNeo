# Activate atomic human Track admission (#9151)

Follow SKILL.md's metadata-only resource guard and isolated proof wrapper. Reuse
existing dependencies. The helper owns an ephemeral non-8399 daemon and fresh
HOME/WAL database; external HTTP and real GitHub are refused. No model, browser,
native app or mock-port preflight is needed. Synthetic notices are injected into
the watcher input; the action itself uses real WebSocket operation.invoke.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-track-admission-activation.ts verify
```

The baseline fails with Track admission SQL executed on main. The committed unit
regression also demonstrates a partial Work card after a late anchor failure.
The fixed journey must prove the real local-human neo.session.track operation:

- Creates a complete adopted doing Work card, with original Unicode title/request,
  worker ref/link and follow anchor. Compare the 324000-byte title and hash through
  public neo.ask.read. Observe an actual immediate mailbox kickoff with matching
  committed root/message/ask/todo identifiers and full notice-derived prompt text.
- Blocks receipt, change publication and kickoff under an imposed 1200ms WAL
  writer; public health stays responsive. Record the missed 250ms receipt target
  honestly, with no early-success or replay workaround.
- Executes zero selected root/card/follow SQL on main, using a prototype execution
  guard installed before startup, including cached handles. Verify its cached
  canary first. Report post-commit delivery target SQL separately. The guard stays
  active through delivery; nonhuman authorization is a separate compatibility test.
- Admits one overlapping Track request and returns the existing duplicate refusal
  for the other, with exactly one card and kickoff. A late anchor trigger failure
  must roll back every card write, change publication and kickoff.
- Rechecks the current root inside the writer transaction. Replace or remove the
  binding after preflight but before command dispatch: card and kickoff must use
  the committed replacement, or refuse. Preserve root-before-notice refusal order.
- Refuses a worker failure before dispatch without a card, fallback or kickoff.
  Discard a real committed worker reply: outcome must be unknown, exactly one
  native command send and one persisted card, no automatic replay or kickoff. An
  explicit repeated tap gets the authoritative duplicate refusal.
- Invokes no work.start/work.send/work.stop operation for the adopted worker.
  These effect doors are trapped. Existing compatibility tests preserve adopted
  worker exemptions and settled follow behavior; the unit slice preserves MCP
  human-only admission and committed-card behavior after kickoff failure.

Run the activation, existing neo-session-track and 5a writer suites, then the full
repository check. Keep the static SQL baseline unchanged or lower; never raise it.
The Deno smoke runs the same helper. Label missing local Deno unverified and require
its CI check. Review and independent Verify bind to the exact final PR head.

Require wrapper exit zero, no background/closed-database errors, resourcesStopped
and verified in neo-track-admission-activation.json. Retain JSON and proof.log;
the wrapper saves evidence before deleting synthetic HOME/data. RSS and WAL are
end-of-run samples, not peaks. Keep #8998/#9002/#8712 open.

After merge, repeat the real Track RPC journey on the containing merged artifact
and read served-build metadata. If the live daemon precedes the merge, record
live smoke pending owner rollout; never restart or mutate it for this proof.
