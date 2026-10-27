# Long human messages fade and fold by text activation (#9086 item 6)

Follow SKILL.md for build, resource guard, isolated HOME/data and cleanup.
The fixture seeds real conversation asks with wrapping words, three short tail
rows, an all-short fallback and CJK paragraphs. External HTTP is refused; no
provider, model turn or live daemon is used.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-message-fade.ts before "$READY"
```

Keep the owning shell alive. READY gives the ephemeral URL, run, PID and seeded
message IDs. In persistent headed Playwright import verifyMessageFade from
neo-user-clamp-check.mjs. Pass each page, READY and
{phase:'before',evidence:'<run>/evidence',touch:false}; repeat with touch:true.
Use 1280x900 light desktop and 390x844 dark mobile. The baseline exposes visible
more/less controls, has no fade and does not prefer a word-bearing cut. Keep that
baseline and commit the failing reproduction before the production change.

Rebuild the fix and repeat after with fresh evidence/READY. Require a maximum
of ten laid-out text rows. The last row should span at least a quarter of the
text width; search upward at most three rows. The short-tail fixture should end
under its seventh row; the all-short fixture keeps the tenth-row cut and shows
⋯. Inspect screenshots for full rows, a visible fade, readable text and no
separate more/less label. Check CJK and both widths. Numeric geometry supports,
but never replaces, visual review.

Click/tap visible text to open and fold; use a point actually inside the
viewport, because scroll anchoring can move the top of an expanded message
above it. Following Safe link must retain the folded state and change the hash.
Enter/Space on the focused text region must open/fold. Component tests also
preserve link handlers and selected text, short-message behavior and the exact
three-row boundary. Shared disclosure's old human-control expectations are
historical only; use this journey for current proof.

Save browser.json with phase after, passed true and both observations after
visual review. Close contexts/browser and signal the helper PID with SIGUSR1.
Require wrapper exit zero; it saves evidence and deletes synthetic HOME/data.
Run clamp/conversation suites, web build and full repository checks. After merge
confirm the served build contains the squash and browser-check these assets
live without restarting the daemon. Isolated proof leaves deployment smoke pending.
