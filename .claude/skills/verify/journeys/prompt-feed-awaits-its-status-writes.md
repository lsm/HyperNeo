# Prompts are consumed and ACP submissions settle with async status writes

Read shared SKILL.md setup. `Database.updateMessageStatus` and
`updateMessageTimestamp` return promises ahead of the move of `sdk_messages`
writes onto the DB gateway writer.
- The message queue awaits its yield callback, so a prompt reaches the SDK only
  after its row is consumed.
- The ACP transport holds a prompt's response until the async `onSubmitted`
  check settles, and a failed check rejects the request even if the agent
  already answered.

```bash
.claude/skills/verify/launch.sh 9441 "$RUN"
# give it the dev-proxy model (SKILL.md, step 3)
VERIFY_PORT=9441 bun .claude/skills/verify/sdk-save-async.ts
.claude/skills/verify/stop.sh "$RUN"
```

Then run `PROOF=.claude/skills/verify/acp-retry-baseline.ts` with the ACP-only
**In-process RPC proofs** setup and `HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS=15000`.

Pass:
- The SDK turn streams `assistant` and `result`, and its user row is `consumed`.
- The ACP proof prints `PASS ACP actual RPC retry`, its conversation contains
  `ACP_RETRY_OK`, and the final counts are `consumed=2`, `deferred=0`.

Not covered live: an ACP prompt revoked between yield and submit. Transport
unit tests pin both orders (the response arriving before and after the check).
