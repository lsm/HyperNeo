# All work items dialog (#9086 item 2)

Use the shared resource guard, build and isolated setup in SKILL.md. The helper
owns a real daemon with fresh synthetic data and external HTTP disabled. No
provider or model turn is needed.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-all-items.ts after "$READY"
```

Keep the owning shell alive. Read the ready JSON for the URL, PID and run. Use
persistent headed Playwright at 1280x900 light and 390x844 touch dark. Import
verifyAllItems from neo-all-items-web.mjs and call it one viewport at a time with
{touch,evidence:'<run>/evidence'}. The before proof records the previous pair of
footer controls, with no All button; preserve that evidence separately.

QA inventory: one full-width 44px All · 30 footer; unfinished work and open
question stay on the card; the named dialog contains in-progress, done, removed,
answered, retired and outcome. First 20 done rows load on opening and the next
five load through the remaining-page control. Inspect card, first-page and
history screenshots in both viewports for fit and readable scrolling. Check no
duplicate anchor IDs, including a removed todo still referenced by an open start
question. Its dialog copy uses a distinct anchor while both surfaces retain it. Escape and Close return focus to All; reopening preserves
loaded pages. The settled-preview helper also checks nested Read all and literal
versions dialogs, links, final text, bounded previews and unchanged open answers.

Exploratory checks: repeatedly open/close using keyboard and touch; open a nested
question dialog after scrolling to the outcome, then close it and confirm the All
dialog remains. Component tests cover failed/refused/stalled pages, refreshed
summaries, Chinese labels and settled-question reference focus. Exact done-todo
reference navigation is a separate follow-up slice.

Save browser.json with phase after and passed true only after inspecting the
screenshots and completing both viewports. Close owned browser contexts and
signal the helper PID with SIGUSR1. Require wrapper exit zero and preserve its
evidence outside the disposable HOME/data. Run NeoAskTodos and full check before
publishing. Live smoke requires a containing served build and the user's explicit
read-only local-browser allowance; never restart or mutate the live daemon.
