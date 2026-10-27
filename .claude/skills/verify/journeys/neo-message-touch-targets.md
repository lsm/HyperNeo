# Neo message touch targets (#9086 item 9)

Follow SKILL.md for build, resources, isolated HOME/data and cleanup. Reuse the
synthetic publications and daemon from neo-whole-message-copy.ts:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-whole-message-copy.ts before "$READY"
```

Keep the owning shell alive. Import verifyIconHitAreas from
neo-icon-hit-check.mjs in persistent headed Playwright. Pass the page, READY
fixture and {phase:'before',evidence:'<run>/evidence',touch:false}. Repeat with
a 390x844 dark mobile context (isMobile/hasTouch true, touch:true). Desktop is
1280x900 light. Both need clipboard-read/write permissions. Before the fix,
message copy, reply, details copy, code copy and retry measure 28x28 pixels.
Retain that baseline and commit the failing browser reproduction before fixing.

Rebuild and repeat with after, fresh evidence and READY. Touch targets must be
at least 44x44, while desktop stays 28x28 with unchanged icon size. The helper
copies actual code into the clipboard and checks exact whitespace. It injects
a controlled WebSocket refusal only for neo.message.send, leaving all other
RPC connected to the real isolated daemon. The visible failed-send Retry is
measured and tapped; exactly one new request must result. No real model runs.

Pressed feedback is checked with a held pointer in the coarse-pointer layout,
after its colour transition settles: tinted background and scale 0.94. Tap
activation is checked with touch input. A CDP-held touch did not expose :active
reliably on this host; this proof does not claim physical-device held-touch or
OS behaviour. Inspect the pressed screenshot and expanded/retry screenshots
for viewport fit, readable code, nonoverlapping controls and visible feedback.
The extra code gutter and minimum block height must keep copy clear of text.

Save browser.json with phase after, passed true and both observation objects
only after visual review. Close contexts/browser, send SIGUSR1 to the helper
PID and require wrapper exit zero. Evidence survives; synthetic data is removed.
Run conversation, message-copy and quote-reply suites plus full checks.
After merge confirm the served build contains the squash, then browser-check
these actual served assets live; never restart the live daemon. Isolated proof
does not substitute for that deployment smoke.

## Mermaid toolbar spacing

Use neo-hit-mermaid.ts instead of neo-whole-message-copy.ts in the same wrapper
command to add a real Mermaid publication. Import verifyMermaidHitAreas from
neo-mermaid-hit-check.mjs and pass the same page/fixture/phase/evidence/touch
options. Before the spacing correction, mobile Expand diagram overlaps Copy
code; capture that reproduction. After the fix both controls are at least
44x44 with a positive gap on touch, while desktop remains unchanged. Open and
close the real expanded diagram and require exact source from code copy.
Inspect both diagram screenshots for clipped diagram content and controls.
Run verifyIconHitAreas too; its pressed assertion requires the exact computed
matrix(0.94, 0, 0, 0.94, 0, 0), not merely a nonzero transform. Save all returned
observations in browser.json before releasing the helper and cleaning up.
