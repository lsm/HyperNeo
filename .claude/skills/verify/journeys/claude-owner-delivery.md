# Claude UUID delivery follows ownership and receiver permission class

Read the shared SKILL.md setup. These proofs never use the human's homes,
credentials, Desktop records, sessions or daemon. Run one heavy job at a time.

Use proof-run.sh with a fresh absolute evidence directory for each invocation:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE/plain" \
  .claude/skills/verify/claude-owner-delivery.ts plain
bash .claude/skills/verify/proof-run.sh "$EVIDENCE/desktop" \
  .claude/skills/verify/claude-owner-delivery.ts desktop
VERIFY_CLAUDE=/absolute/path/to/installed/claude \
  bash .claude/skills/verify/proof-run.sh "$EVIDENCE/native-default" \
  .claude/skills/verify/claude-owner-native.ts default
```

Repeat the native invocation into separate evidence directories with `auto`
and `bypassPermissions` to exercise those installed receiver modes. Select
`TMPDIR=/private/tmp` for the native socket paths, per shared setup. The native
helper owns an ephemeral loopback model server, so omit the 8000/8001 preflight.
It supplies its synthetic API key through an isolated native apiKeyHelper,
never through the daemon environment. Its synthetic discovery executable and
process snapshot describe only the owned native child. The native child itself
is the installed executable named by VERIFY_CLAUDE, not the discovery fixture.

Observe observed.json, proof.log and run-status.json for every invocation:

- With no Desktop installation/records in the synthetic home, a busy or idle
  CLI receiver in default, auto or bypassPermissions accepts the matching input
  without a held receipt. Socket-write results remain explicitly unconfirmed.
- A registered Desktop UUID addressed through the Code adapter uses the existing
  Desktop adapter: a live input confirms against the target transcript; a stopped
  target uses one existing auto headless turn. A registered session currently
  owned by sdk-cli uses the shared receiver-mode matcher rather than undefined.
- Unknown modes, unknown ownership, duplicate live candidates and a wrong local_
  ID write no input. A stopped unregistered CLI target is not resumed. Explicit
  receiver hold/refuse policies remain effective; waiting produces no resend.
- Each native run first sends an opposite-class control directly: the installed
  receive-side gate reports peer_message_hold / mode-mismatch then expired.
  Its approval deadline is shortened to 700 ms only inside that native child.
  Next, an actual isolated-daemon work.send during an active model turn reaches
  the native model's next request without any held event for that input UUID.

The daemon/peer matrix simulates Desktop, process discovery and the native peer;
the native proof exercises the actual installed receive-side runtime with a local
model mock. Neither proves Desktop GUI rendering, GUI approval, real provider
behavior or a live-session send. Preserve the existing Desktop held-retry journey
for its one-relay fallback; do not replace it with another retry implementation.

Both helpers close their sockets, servers and owned processes in finally. The
shared wrapper retains evidence and removes the disposable homes/data, including
failures. A nonzero wrapper result is a failed proof even if a PASS line appeared.

Also run the optional Desktop plugin's native-send compatibility contracts:

```bash
cd packages/daemon
bunx vitest run --config vitest.config.ts tests/unit/1-core/drivers/claude-desktop-mods-driver.test.ts tests/unit/1-core/drivers/claude-owner-delivery.test.ts
```

Its valid receiver fixture must provide a permission mode and receipt-bound
transcript input. The separate missing-mode case must refuse without sending;
plugin queue controls must continue to preserve confirmed native send/steer.
