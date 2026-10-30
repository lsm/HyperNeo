# Bounded Gmail search through a named connected account

Run from a checkout with dependencies installed:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/google-search.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and the pinned Deno executable on PATH.
The shared wrapper supplies a fresh test HOME/data/database and scrubs credentials.
No real Google login, keychain, account, model or external service is used.

The helper starts an isolated daemon and fake Google HTTP server on free loopback
ports. Synthetic grants seed two named accounts. The daemon's default operation
registry and real MCP adapter discover account ids and search only the selected
account; a local management RPC disconnects it during an in-flight request.

Check `google-search.json`: account routing, opaque pagination, metadata-only
requests, clipped headers/snippets, explicit untrusted output, token redaction,
unknown-account and caller refusal, scope admission before network I/O, one
401 refresh/retry, bounded persistent 401/429/timeout/oversized/over-limit/redirect
failures, disconnect cancellation and no post-disconnect request. There is no send
operation or full-body response. Both servers and the daemon close in `finally`.
The proof covers daemon/MCP behavior, not a model's choice of tools or a real
Google account. Unit contracts separately pin strict input bounds.
