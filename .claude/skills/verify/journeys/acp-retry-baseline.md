## An accepted ACP input retries through the actual protocol

Set `PROOF=.claude/skills/verify/acp-retry-baseline.ts` and use the ACP-only
**In-process RPC proofs** setup in SKILL.md. No model HTTP mock or fixed TCP
ports are needed. Add `HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS=15000` to the
isolated environment.

The helper registers a synthetic ACP provider and sends kickoff through
WebSocket RPC. Its stdio agent fixture supports session loading, accepts the
first prompt and waits while a follow-up is durably deferred. The helper then
releases a `TypeError: fetch failed` ACP response. A fresh agent process must
receive both the retried kickoff and follow-up, and the conversation RPC must
contain `ACP_RETRY_OK`. Final RPC counts must be `consumed=2`, `deferred=0`.

Evidence is `$RUN/evidence/acp.json`, including provider-protocol calls with
process IDs, prompt markers, conversation RPC output and final counts. Fixture
logs and release files stay inside the synthetic HOME. GitHub is stubbed and
all resources close in finally; no credentials or real provider traffic are used.

This is a characterization, not a failing reproduction: it passes on unchanged
dev `c3b1809f75`, as does the real-MessageQueue unit fixture. ACP directly owns
its for-await reader and closes it on error before retry; it has no SDK-style
background reader waiting for the next prompt. The reviewer advisory alone did
not establish an ACP stale-reader failure, so this case does not justify an
ACP production change. Browser rendering is not exercised.
