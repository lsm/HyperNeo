1. **A human message reaches root Neo, which answers.**
   `neo.open {}` returns root's `sessionId`; send
   `neo.message.send {"sessionId":"<root>","requestId":"<uuid>","content":"Is the web header fix merged?"}`.
   End state: `sdk_messages` for root holds the user message (with its local-time
   line) and, within ~25 s, an `assistant` and a `result` row from the mock. The
   mock returns plain text, so no publication is written; a publication needs a
   scripted model (see `tests/online/convo/neo-publication-sdk.test.ts`).
   For the root visibility prompt experiment, run that focused online test with a fresh
   temporary HOME and `env -i` as documented in `packages/daemon/tests/online/README.md`.
   It starts its own isolated test daemon and loopback scripted model, checks the assembled
   `neoPrompt()` reaches the real SDK, and reads back the exact publication through RPC.
   The final prompt block must keep ordinary turns silent, using publish/question for
   the human, while scheduled goal wakes alone end in a one-line wake-row label.
   The root prompt still has its word-cap unit test.
   This proves prompt delivery and publication plumbing, not a generative model's choice
   to publish or stay silent. Without a permitted local model, report that behavior as
   unverified; do not use live credentials or treat the script as behavioral acceptance.
