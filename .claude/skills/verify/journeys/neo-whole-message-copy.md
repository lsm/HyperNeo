# Copy a complete Neo message (#9086, item 3)

Use SKILL.md's resources, isolated environment and existing dependencies. Build
the web first under the resource guard. No provider, real DB or external request
is used; the helper seeds only its synthetic DB and verifies the publication
through the real reader before opening the real `/neo` UI.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-whole-message-copy.ts before "$READY"
```

Keep that owning shell alive. `$READY` is a fresh absolute JSON file outside
the disposable run; it supplies the ephemeral URL, run, helper PID and expected
source text. The helper waits for attended browser evidence. Before the fix,
footer and touch long-press Copy in both viewports omit the short reply. Retain
`baselineReproduced: true` as a reproduction, not a fix pass.

After rebuilding the fix, use `after` with a fresh evidence directory and ready
file. In the persistent headed Playwright session, create desktop 1280×900 and
touch 390×844 contexts, with clipboard-read/write permissions and light/dark
theme coverage. Enable touch input (`hasTouch: true`) in both contexts: the
custom Copy menu is opened by CDP touch long-press at either viewport, because
mouse right-click now belongs to the browser (see #9113). Import
`verifyWholeMessageCopy` from the adjacent
`neo-whole-message-copy-web.mjs`; pass each visible page and the ready fixture,
plus `{ phase, touch, evidence: '<run>/evidence' }`. Invoke one viewport at a
time and inspect its screenshots. The helper waits for finite arrival animations
before capture; a dim frame mid-animation is not a visual pass. This is an attended browser journey; never
leave an unattended GUI run behind.

Require real clipboard contents to equal short Markdown, a blank line and full
details whether collapsed, expanded or folded again. Long-press Copy must match.
Details copies only fullText, quote Copy retains its existing plain-text scope,
and code Copy retains exact displayed code whitespace. Equal short/full and
verbatim publications copy once. Preserve existing copy feedback and verify
horizontal viewport fit. Explore switching between block/whole copies and
repeated expansion/menu cycles; inspect initial, expanded and folded screenshots
for clipping, control legibility, overlays and feedback.

Save `browser.json` with `phase`, viewport observations and `passed: true` only
after all fixed checks and visual review pass (`baselineReproduced: true` for
before). Close owned browser contexts, then send SIGUSR1 to the printed helper
PID. Its finally closes the preview, WebSocket and daemon; the wrapper saves
evidence and immediately removes temporary HOME/data. A wrapper failure or an
inconclusive browser check is not a pass.

Run focused public-conversation, message-copy and quote-reply component tests
plus the full check. The fixture deliberately uses only schema-valid stored
publications; component tests cover older single-part/verbatim combinations too.
The other eight #9086 items and native iOS are outside this slice.

After merge, confirm the served web build contains the squash and repeat the
browser clipboard checks against its actual served assets, with synthetic data
and no live-daemon restart. If a permitted served-web URL or containing build
is unavailable, report deployment smoke pending; isolated-source proof alone
does not complete that live gate.
