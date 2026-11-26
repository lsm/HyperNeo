# OXAP chat sends each accepted prompt once

Use the shared isolation and pinned Bun in `../SKILL.md`. Use the pinned OXAP
release binary and check the release archive's checksum as described in
`oxap-deepseek-first-message.md`. Pass its release name and the extracted
binary's SHA-256 to each command. Use a fresh evidence directory each time.

```sh
HYPERNEO_SPACE=off TMPDIR=/private/tmp VERIFY_PROOF_PREFIX=or- \
  bash .claude/skills/verify/proof-run.sh "$CODEX_EVIDENCE" \
  .claude/skills/verify/oap-workspace-wire.ts "$OXAP" "$RELEASE" "$SHA256" no-replay

HYPERNEO_SPACE=off TMPDIR=/private/tmp VERIFY_PROOF_PREFIX=or- \
  bash .claude/skills/verify/proof-run.sh "$DEEPSEEK_EVIDENCE" \
  .claude/skills/verify/oxap-deepseek-first-message.ts "$OXAP" "$RELEASE" "$SHA256" no-replay
```

The Codex fixture uses the published hub and a synthetic Codex app-server.
Send a prompt over chat RPC, wait past the shortened silence deadline,
change the default harness to Claude Code, restart the disposable daemon,
then send a second prompt to the same chat. The synthetic run also leaves
the first chat's state recorded as processing to exercise interrupted-turn
recovery. The chat receives two successful results. The peer records two
`turn/start` calls on one native thread. The first row keeps its timestamp
and consumption sequence. The DeepSeek peer records one native
`session/prompt` past the same deadline and the prompt row stays unchanged.

For an explicitly authorized real Codex proof, repeat the Codex command with
the absolute Codex executable and its signed-in home directory after
`no-replay`. Only the Codex child uses that home. The daemon keeps its
disposable HOME, database and loopback listener. The relay records method
names only. Expect the same native call counts across the daemon restart.

Run `oap-hub-busy-backoff.md` to confirm the shared hub still retries a
transient refusal once. Run the `healthy_chat_send_is_not_rebuilt` and
`swallowed_message` cases in `human-send-recovery.md` for the Claude Code path.
