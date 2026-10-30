### One-use Google loopback login (phase 1.2b)

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/google-loopback \
  .claude/skills/verify/google-loopback.ts
```

Also run the same command with `--slow-token` after the helper path, using a
fresh evidence directory. Its 12-second fake token response must still complete
within the exchange's 15-second bound, without the callback resetting at Bun's
default 10-second HTTP idle timeout.

Use `VERIFY_PROOF_RUNTIME=deno` with pinned Deno 2.9.4 on PATH for the second
runtime. The shared isolated setup supplies fresh HOME/data/database and test mode.
No model, credentials, real Google endpoint or GUI is used.

The helper boots a test daemon and fake Google consent/token/JWKS server. Actual
HTTP follows the fake consent redirect to the production loopback listener. Wrong
state, path, method and Host must be refused without exchanging a code; concurrent
replay exchanges only once. The token endpoint checks PKCE and the exact redirect
and client; the signed identity completes login. Expiry, cancellation and denial
close their attempts without another exchange. Responses never reflect tokens.
The helper cancels all attempts and closes its servers in finally, retaining only
outcomes in `google-loopback.json`.

This construction slice does not expose management operations or a browser
settings flow yet. It proves the consent/loopback HTTP boundary with synthetic
data, not real Google consent deployment or account interoperability.
