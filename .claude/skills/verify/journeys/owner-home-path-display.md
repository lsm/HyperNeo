# Owner-home file reference labels

Use the shared resource check, isolated launch/stop and browser setup from
SKILL.md. Follow file-reference-cards-b1.md, replacing its seed helper with
owner-home-web-seed.ts and its browser proof with verifyOwnerHomeLabels from
owner-home-web-proof.mjs. Pass {run,base,width} at desktop 1280 and phone 390.
The seed creates actual files inside the synthetic HOME and a prefix-sibling
outside it. Do not use a human HOME, database, account, daemon or browser.

The daemon snapshot supplies its own system.homeDirectory. Check the message's
recognized home paths and file:// labels show ~/reports/..., while the sibling
home path, custom link title, fenced example and Copy message/quote retain their
original text. Metadata missing/changed and a known remote owner are unit controls:
never infer /Users/name or /home/name. Cards keep their basename and shortened
owner-path tooltip. Clicking must send the original absolute/encoded reference to
file.reference.read. Verify actual current content, edit/reopen, Download and
missing on reopen, with no registration or snapshot resolve. Ask Neo prepares the
absolute path, not its display label. Keep legacy saved/Git previews separate.

Inspect screenshots at both widths, hover titles, wrapping, keyboard/focus,
close/reopen and page errors. Record the original RPC targets and fake clipboard
values, without using the human clipboard. Close owned browser contexts and stop
the daemon/mock before removing temporary data. After daemon merge/deploy, record
owner build/PID/health and repeat this journey from the merged source and bundle.
Only then write the requested persistent tilde-web evidence file.
