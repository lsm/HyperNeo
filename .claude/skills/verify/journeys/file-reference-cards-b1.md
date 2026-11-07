# File cards from public Neo text (B1)

Use shared setup and cleanup from SKILL.md. Follow `live-file-web-a4.md`, replacing
its seed helper with `file-reference-cards-b1-web-seed.ts` in both seed/publish
phases, and its browser proof with `file-reference-cards-b1-proof.mjs`. Build web
first. Keep one owning shell alive; stop the daemon before publishing synthetic
fixtures directly to its isolated database, then restart it. Use two free ports,
synthetic HOME/data, no real provider/account, and the Git stub. Close every owned
browser and daemon. Do not drive a human browser or touch a live database.

The new fixture keeps the saved-attachment/Git controls and adds a question and
todo whose public body/document/detail repeat the same owner-absolute file. Their
metadata contains another filename which must not become a card. The proof clicks
publication, question and expanded todo cards at desktop and phone widths. It
also clicks the inline todo title path, verifies its source-bound preview, clicks
the non-link title text to expand the row, and opens a path from a question's
full report with Enter, then confirms focus returns to its report button after
the preview closes. A `.sh` path in each remains plain text while the `.md` path is
clickable. One
exact path produces one card; labels distinguish Current file and Saved attachment.
Bare/relative PR filenames remain prose and do not generate cards or automatic
links. Current Markdown/HTML/image edits show on reopening, deletion reports missing,
unsupported PDF stays plain text, Download rereads complete current bytes,
and no artifact/identity rows are created. Every live call retains its actual
source and literal reference; saved IDs and fixed-head Git captures still work.

For interactive QA import `verifyLiveFilePage` (with `cards:true`) and
`verifyCardSources` through the playwright-interactive skill; pass an owned page
and `{run,base,width,bun}`. Inspect settled desktop/phone screenshots separately,
including collapsed/expanded todo details, long paths, errors and Back/close.
Check keyboard focus and confirm original message/verbatim/copy behavior remains.

Run `bun test ./tests/unit/1-core/operations/file-reference-cards.test.ts` from
packages/daemon. It runs real RPC against an isolated ephemeral daemon: question
body/document authorization, recorded worker versus same-named root file, absent
owner/remote refusal, unknown/revision/metadata-only denial, edit/re-read/delete,
and unchanged registry counts. Client tests also cover exact encoded file URLs,
same-named different paths, visible status/action text and unsupported feedback.

After daemon merge/deploy, record owner build/PID/health and repeat the browser
and real-RPC proof from the merged checkout. Keep isolated UI proof distinct from
owner build readback; do not claim a paired-human production click without one.
Only then write the slice evidence file and remove the PR worktree.
