### Google authorization-code exchange and identity (phase 1.2a)

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/google-token-exchange \
  .claude/skills/verify/google-token-exchange.ts
```

Run the same helper with `VERIFY_PROOF_RUNTIME=deno` and the pinned Deno 2.9.4
on PATH to exercise the second supported runtime. Keep each evidence directory fresh.

The shared setup supplies a fresh HOME/data/database, test mode and no credentials.
The helper boots an isolated daemon and a local fake Google token/JWKS server on
ephemeral ports; it refuses all other network targets and closes both in finally.
Actual HTTP requests must carry the bound code, client, redirect and PKCE verifier.
The fake signs a synthetic identity with an ephemeral RSA key; the production
exchange primitive fetches its public JWKS and verifies the signature/claims.
Issuer, audience, nonce, expiry, authorized-party and unverified-email changes
must all be refused. Returned scopes are the actual partial grant. The report
contains outcomes, never token bodies or signing keys.

Unit contracts additionally cover forged signatures, malformed grants, omitted
refresh tokens, chunked response limits and in-flight cancellation. This is a
construction slice: consent/callback listening and RPC/UI login do not exist yet.
The proof exercises the internal HTTP boundary in a test-daemon process, and does
not claim public login wiring or real Google interoperability.

References: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
