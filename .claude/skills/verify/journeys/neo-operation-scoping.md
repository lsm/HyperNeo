# Neo operation scoping

Run the metadata-only `neo-operation-scoping.ts` helper with `proof-run.sh` on
an isolated test host. It starts a fresh daemon on an ephemeral port, stops its
job processor, and drives the real registry through the MCP adapter. GitHub is
stubbed; no provider or live credentials are used.

The helper checks a role-denied malformed call, disabled coding discovery,
descriptions and typo suggestions, then enables coding and invokes its GitHub
reader in the same session. Bare and all:true Neo lists must return namespace
counts, prefix pages carry at most twenty names and a cursor, and the human
RPC adapter must retain byte-identical full-catalog output. Retain `observed.json`, `proof.log` and
`run-status.json`. A successful run prints registry and caller counts. The evidence also records
index and first-page UTF-8 byte counts.
The unit regression also covers a legitimate workflow caller and unchanged
non-Neo access. This journey does not verify browser layout or model turns.
