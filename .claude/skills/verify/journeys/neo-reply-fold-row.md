# Neo reply more/less on its own row (#9086 item 8)

Follow SKILL.md for resource guards, build, isolation and cleanup. Reuse the
synthetic publications and real daemon from neo-whole-message-copy.ts:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-whole-message-copy.ts before "$READY"
```

Keep the owning shell alive. Read READY for the ephemeral URL, run and helper
PID. In persistent headed Playwright import verifyReplyFold from
neo-reply-fold-layout-web.mjs and call it with the page, READY fixture and
{phase:'before', evidence:'<run>/evidence', touch:false}. Repeat with a mobile
touch context. Desktop 1280x900 light reproduces more sharing the short reply's
last line; mobile 390x844 dark can already wrap it below. The expanded code
block can already have less on a separate row. These are baseline observations,
not a pass for the fix. Save browser.json with phase before,
baselineReproduced true and both returned observation objects.

After rebuilding the fix, repeat with after and fresh evidence/READY paths.
Require more and less below the last visible text in collapsed, expanded,
folded and reopened states. Inspect screenshots of all four states at both
viewports for readability, right alignment, horizontal fit and footer overlap.
Use mouse on desktop and taps on mobile. These repeated cycles and the code
block ending exercise wrapping and folding beyond the initial happy path.
The existing component suite also covers long paragraphs, numeric replies,
copy scope and body clicks that must not toggle Details.

Write browser.json with phase after, passed true and both viewport observations
only after inspecting the screenshots. Close contexts/browser, signal the
helper with SIGUSR1 and require wrapper exit zero. Evidence is retained outside
the disposable run; synthetic HOME/data are deleted by the wrapper. Run the
NeoPublicConversation suite and full check before publication.

After merge confirm the served web build contains the squash, then repeat the
same browser checks using its actual assets and synthetic publications. Never
restart the live daemon. If no containing live build is available, report
live deployment smoke pending; isolated proof does not satisfy that gate.
