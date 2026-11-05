# Retired local registration (C3)

Use SKILL.md resource/isolation/cleanup setup. The registered operation must be
absent from discovery and both actual RPC and MCP invocation must return
unknown_operation, with no file rows created. The helper uses a real isolated
daemon, fresh HOME/data, a synthetic file and an ephemeral non-8399 port.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/register-evidence .claude/skills/verify/retire-local-register.ts verify
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/legacy-evidence .claude/skills/verify/retire-local-tap.ts verify
```

The second helper now seeds a synthetic historical attachment directly; it does
not invoke registration. It checks old local taps still demand an upgrade, the
current reader reads A then edited B then missing, saved bytes remain A and no
additional rows/blobs appear. Both wrappers must exit 0 and close all resources.

Run preview-register, preview-reads, preview-html, preview-bundle,
preview-resolve, preview-git-capture, preview-git-resolve, preview-pr-summary,
artifact-git-identity, artifact-git-row, artifact-reference-identity,
native-artifact-binding, claude-artifact-binding and preview-policy regressions.
The old registration service/receipt tests are retired; shared Git row/identity,
Connections namespace and legacy reader tests remain. Historical fixtures in
legacy-attachment-fixture.ts write synthetic rows/blobs only, under the test
HOME; they provide no public endpoint, authorization or capture implementation.
Browser/RPC fixture preparation uses that test helper, never an old API alias.

The existing B1 and owner-home web journeys retain their historical attachment
and fixed-head Git controls, using the migrated fixture setup. Run the real
browser journey against this checkout and inspect current versus saved controls;
keep actual source/reference wire identities, edit/reopen/delete, download and
Back behavior. Do not use a human account, DB or paired browser.

No stored rows/blobs, artifact_file_identity, workflow tables, todo evidence,
Git capture or legacy reader format may be deleted. After daemon merge, use
the authorized idle-deploy procedure and owner build RPC readback, then rerun
these native proofs from the merged commit. Keep build readback separate from
isolated byte proofs; do not claim a production paired-human click without one.

Keep its log and exit status; a missing helper or an early shutdown failure is not a pass.
The compatibility-pins journey uses the surviving authorization/path primitives; its
handoff capture/restart/read assertions stay separate from local registration. Historical
measurement script names now inventory current Git/legacy boundaries; they never read the
deleted service or claim old hashes are unchanged.
