# Completed todos can fold again (#9086 item 1)

Follow SKILL.md for resources, build, isolated HOME/data and cleanup. The fixture
uses only a real isolated daemon and synthetic Work cards, with external HTTP
refused and no provider or model turns.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-done-fold.ts before "$READY"
```

Keep the owning shell alive. READY contains the ephemeral URL, run, helper PID
and cards holding 2, 5 and 25 completed todos plus one unfinished todo each.
Import verifyDoneFold from neo-done-fold-web.mjs in persistent headed Playwright.
Pass the page, READY fixture and {phase:'before',evidence:'<run>/evidence',touch:false}.
Repeat with touch:true on a mobile context. Use desktop 1280x900 light and mobile
390x844 dark. The mobile check opens Your work. Before the fix all done rows can
be revealed, including the 25-item paged list, but there is no way to fold them.
Preserve the baseline and the signed failing component reproduction first.

The All dialog supersedes the inline done controls. On current web, the same
after helper opens All, pages all rows, closes it to hide them and reopens the
cached rows for all three list sizes. See neo-all-items-dialog.md for the full
history surface. Preserve the original inline-fold evidence as historical proof.

On the original #9239 build, rebuild and repeat after with fresh evidence. Small lists
keep their initial visible rows. Larger lists reveal and page through the real
neo.ask.doneTodos operation. Hide done todos must remove every completed row
while leaving the unfinished row. Reveal again must restore all cached rows,
then another fold must work too, including lists larger than one page.
Inspect expanded/folded card screenshots at both widths for readable labels,
clear controls and horizontal fit. The component cases additionally require
cached reveal not to fetch already loaded pages. Paging, snapshot updates and
read-failure/retry remain covered by the existing NeoAskTodos suite.

After visual review write browser.json with phase after, passed true and both
viewport observations. Close contexts/browser and send SIGUSR1 to the helper
PID. Require wrapper exit zero; evidence is retained and synthetic data removed.
Run NeoAskTodos and refresh suites, web build and full repository checks.
After merge confirm the served build contains the squash and check this same
behaviour on its served web assets live. Never restart the live daemon; an
isolated-source pass does not complete the deployment smoke gate.
