# Complete file paths next to Chinese text

Run SKILL.md's isolated wrapper with `file-path-boundaries.ts`. It reads only the
synthetic vectors in `packages/shared/tests/fixtures/file-path-boundaries.json`.
No captured messages or real database are fixtures.

The helper publishes each vector through real Neo MCP and reads every expected
path through the actual `file.reference.read` WebSocket door. A path whose format
the daemon cannot preview gets no link or card, and its explicit read still returns
`unsupported_type`, rather than an authorization refusal. Shared extraction
and web FileReferenceCards must agree with the same vectors. Before the fix,
`报告：/…/b.md` has no card and its exact read is forbidden. After the fix, its
current bytes are readable. Unmentioned files must stay forbidden and no artifact
rows are added. The wrapper saves receipts before deleting synthetic HOME/data.

For real web proof, build this checkout's web app under the shared resource guard.
Add `--browser /absolute/fresh/control-directory` after the helper path. Read the
control directory's browser.json and open its loopback proof-entry URL. That route
authenticates only the fresh synthetic browser; never use a live credential.

Find the publication `报告：/…/可读报告.md。`. Require one current-file card for
可读报告.md and click it. The viewer must show Chinese boundary report and the
current source-owner bytes. Save a screenshot and a short observation record in
the evidence directory, then create doneFile. Record `passed: true` in browser.json only after the
positive card reads and `_~/report.md` has no false card; the helper requires
that successful observation. Close the owned browser tab. The
helper closes both servers and its socket; the wrapper removes its temporary data.

Retain shared/web test logs and the isolated run status. The historic 38→149 card
count belongs to the design author's prototype rerun unless independently rerun;
never infer that corpus result from these synthetic checks. Do not put real
publication text or machine paths into repository tests. iOS consumes the same
rule/vectors in its subsequent PR; this journey does not verify an iOS client.
