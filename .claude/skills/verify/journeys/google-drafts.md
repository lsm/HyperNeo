# Prepare an unsent Gmail draft and read it back

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/google-drafts.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and pinned Deno on PATH. Python 3 is
required for its independent standard-library MIME parser. The helper invokes it
in isolated mode with MIME on stdin; no files or credentials are imported.
The shared wrapper supplies fresh test HOME/data/database and scrubbed credentials.
One isolated daemon and fake Google HTTP server use free loopback ports.

Check `google-drafts.json` and the synthetic `.eml` files. Through the real default
registry/MCP adapter, create a draft with To/Cc/Bcc, a long Unicode subject, UTF-8
text and a small binary attachment with a Unicode filename. Python must parse it
without defects and recover the exact content. Read its thread through MCP,
update the same draft, and observe the stable draft id and changed message id.
A second account must use its own verified sender and bearer grant.

Unknown accounts, ineligible sessions, missing compose scope, sender overrides,
header/path injection and send requests must fail before API access. A 401 may
refresh and retry once, preserving the exact prepared MIME and causing one draft
effect. A server failure after writing reports `draft_outcome_unknown` and causes
one request, never an automatic retry; check Gmail drafts before retrying.
The Google catalog exposes no send tool or raw HTTP proxy. Only the typed draft
create/update endpoints can receive mail writes. All resources close in `finally`.

Inputs allow ten addresses per To/Cc/Bcc field, 200 subject characters, 4,096 text
characters and two attachments of at most 8 KiB each. The encoded MIME is capped
at 64 KiB. Draft ids are literal resource identifiers, never endpoint paths.
This proves fake-endpoint control flow and MIME round trips on the daemon/MCP
surface, not real Google interoperability or a model's choice of tools.

References: [draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts),
[drafts.update](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/update).
