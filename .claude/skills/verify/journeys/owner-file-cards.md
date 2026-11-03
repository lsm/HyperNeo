# Explicit owner paths for generated Neo file cards

Use SKILL.md's isolated metadata wrapper with owner-file-cards.ts. It invokes
real neo.publication.publish through MCP, then file.reference.read over an actual
WebSocket. A synthetic Neo cwd under its synthetic HOME's hidden data directory
contains CLAUDE.md, while a separate repository contains a different same-name
file. Require the publication source to resolve to Neo's cwd; policy must return
sensitive_path and the real reader forbidden for the bare name. Do not weaken
that denial or guess the PR's checkout. The explicit report path must read A,
reread B, then report missing, with no artifact rows or blobs.

The linked-candidate helper must exclude bare/relative local names while keeping
absolute, home-relative and full Git URLs. The raw candidate grammar and explicit
source-bound relative RPC reads remain unchanged. Run OwnerPathDisplay,
NeoPublicConversation and NeoArtifactTaps web tests plus owner-file-cards.test.ts.
The daemon test also executes the B1 and owner-home browser seed entrypoints in
fresh synthetic homes and checks their generated Markdown fixture.

For real-browser QA, build web, create a fresh RUN/home/tmp/bin and invoke the
same native helper as `owner-file-cards.ts --seed RUN` under the scrubbed shared
environment. This restores report A after its native read/edit/delete proof.
Launch that fixture using launch.sh with two free ports. Import
owner-file-cards-web.mjs through the playwright-interactive skill, pass an owned
page and `{base,report,evidence,width}` to verifyOwnerFileCards, and check 1280
and 390 widths. Require visible prose with no bare/relative card or automatic
link, exactly one absolute report card, actual clicks showing A then B then
missing, and only source-bound file.reference.read requests for that report.
Inspect settled screenshots; close owned browser/contexts and stop daemon/mock
before removing the marked owned fixture. Preserve evidence outside RUN.

Cards are derived on each client, not served by the daemon. This HyperNeo proof
covers web and daemon authorization; iOS has its own FileCardReferences parser
and requires a separate client change and phone approval. Do not claim a phone
fix or a sourceId readback from a reported session cwd.
