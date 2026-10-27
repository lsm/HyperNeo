# Work references open All at the exact held item (#9086 item 2)

Use the resource guard, build and isolated setup from SKILL.md. The helper owns
a synthetic daemon, conversation and work history. It refuses external HTTP and
uses no provider, real database or native app.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-work-item-navigation.ts before "$READY"
```

The fixture holds 25 completed todos and an older settled card outside the
snapshot's ten-outcome window. Exact daemon readers must find the owner even
though the snapshot omits it. Use persistent headed Playwright at 1280x900 light
and 390x844 touch dark. Import verifyWorkItemNavigation from
neo-work-item-navigation-web.mjs and pass {phase,evidence:'<run>/evidence',touch}.

Before the fix, the completed-todo quote does nothing and the two settled-card
notices show unavailable. Preserve those screenshots and commit the failing
reproduction first. After rebuilding, repeat with phase after in fresh evidence.
Each link must open the named All dialog, page through offset 20 for todo 25,
and focus/highlight the exact todo, answered question or retired question.
Inspect all six screenshots for readable selected rows, viewport fit and usable
scrolling. Existing open-question controls and replacement links must still work.

Import verifyWorkReferenceRecovery from the same browser helper. In separate
contexts at both widths it checks repeated activation, a synthetic read refusal
followed by retry, and Back to chat while an exact read is held. It releases the
real request and waits for its response before asserting the late result cannot
reopen Work. Save browser.json with phase after and passed
true only after functional and visual review. Close owned contexts, signal the
helper PID with SIGUSR1 and require wrapper exit zero. Run Work-scene, card and
public-conversation suites, build and full checks. Deployment smoke requires an
automatically served containing build and the explicit read-only browser allowance.

After merging Work search, also run verifyFilteredWorkReference at both widths.
It applies a nonmatching query, closes the mobile Work sheet when needed, then
activates the older answered-question link. Preserve the separate before proof
where the query hides the target. After must clear the query and focus the exact
row inside All. This uses the real search index and daemon reader.
The browser helper waits for currently running finite animations with a bounded
deadline; it does not hold old animation promises across sheet replacement.
