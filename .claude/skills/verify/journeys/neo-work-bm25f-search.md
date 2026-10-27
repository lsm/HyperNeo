# Client-ranked Work search (#9086 item 7)

Follow SKILL.md for build, resource guard, isolated HOME/data and cleanup. The
fixture owns a real daemon, five synthetic cards and the built /neo assets.
External HTTP is refused; no real provider, model turn or live DB is used.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-work-search.ts after "$READY"
```

Keep the owning shell alive. READY contains the ephemeral URL, run, PID and
corpus. Import verifyWorkSearch from neo-work-search-web.mjs in persistent
headed Playwright and pass each page, READY and
{evidence:'<run>/evidence',touch:false}. Use 1280x900 light desktop and 390x844
dark touch, with touch:true for mobile. Mobile opens Your work by its accessible
name prefix, which can include an attention count.

The magnifier starts collapsed, then opens a focused field. Searching needle
must rank ask title, todo title, status and report in that order. The client
uses BM25F with weights 3/2/1/0.5, k1 1.2 and b 0.75; Unicode words plus CJK
unigrams/bigrams form its terms. Full bodies are read when a nonempty search
begins, then indexed once for that feed revision; later query changes must not
cause more reads. Request, report, evidence, outcome, question and Chinese-only terms
must find their exact card even when the initial summary omitted that body.
Search covers the loaded Work feed, including any history pages already loaded.
Import verifySearchRequest from neo-search-request-web.mjs and run it at both
widths with phase after. Words and CJK text present only in the original request
or a question answer must find the ask. Preserve separate before proofs showing
No matching work. For the answer-only baseline pass queries:['answercipher736','回答']
to verifySearchRequest, because request matching was already fixed at that point.
The useNeoWorkSearch result boundary can later use neo.ask.search without
changing the search controls or ranked result rendering.

Require No matching work for an unmatched query, with no stale cards. Escape
clears search and restores all cards without closing the mobile Work sheet.
The helper injects one controlled neo.ask.read WebSocket refusal; that must show
a distinct read error, never a false No matching work. Closing and reopening
search must recover. For the review regressions, also import verifySearchRecovery
from neo-search-recovery-web.mjs and run it with phase after in separate contexts
at both widths. It holds retry reads to prove Searching work… replaces the old
error, then releases them and checks results. Chromium controlled IME composition
plus keyboard Escape must preserve the CJK query; an ordinary Escape still closes.
This exercises real browser composition events, not a physical OS IME candidate
window. Preserve the separate before evidence reproducing both bugs.
All other RPC reaches the real isolated daemon. Inspect
closed, ranked, ranked-tail, empty and recovered screenshots for settled
animations, readable cards, a usable field and horizontal fit at both widths.
Scroll is intentional when ranked cards exceed the viewport.

After visual review write browser.json with phase after, passed true and both
observations. Close contexts/browser, send SIGUSR1 to the helper PID and require
wrapper exit zero. Evidence remains; temporary HOME/data are removed. Run rank,
source-hook and Work-scene suites, web build and full checks. After merge confirm
the served build contains the squash and browser-check its actual assets live;
never restart the daemon. Isolated proof does not complete deployment smoke.
