# Queue filters and attachment hover in the Neo Inbox

Use the pinned runtime, resource guard and isolated daemon setup in ../SKILL.md.
Build the web bundle at the checked-out head, then run the desktop web journey:

```sh
VERIFY_BROWSER=<chromium> VERIFY_PLAYWRIGHT=<playwright-package> VERIFY_MOCK_PORT=29347 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/human-queue-web.sh \
  29346 <phase> <absolute-evidence-directory>
```

This seeds five asks across two projects in a fresh synthetic DB. A trip has one
waiting card, one held card and uncovered work. No provider or model turn is used.

Before must exit 1 with both themes reporting the duplicate standalone filter
row and the oversized attachment hover. After must exit 0. The Inbox retains
its state and topic rows, including More. Hold moves a question to Held, Take back
returns it, and In progress shows uncovered work. The attachment button opens
the file picker, with a 32px circular hover face centered in its 44px target.

Inspect the individual light and dark PNGs for each phase. The screenshots and
geometry receipts are captured from the paired desktop-width web UI.

Use `topic-before` on the head that first hid the standalone row. The helper
loads a saved Travel topic, captures the missing Finance work in both themes
and exits 1 with In progress 1. The `after` phase repeats that check and requires
In progress 2 with both asks visible and topic badges read-only. The saved-topic
PNGs show the counts immediately after reloading.

Use `layout-before` on the head with the text More select. It captures both
themes and exits 1 when the header gap is at least 20px and the ask controls wrap.
After requires an 8–16px gap and a single line at desktop and 390px widths.
The More icon stays at the right edge when the narrow chip strip scrolls.
Check keyboard focus and pick an overflowing ask through the native select.

Use `short-topics` for the 12-cell topic contract. The paired Chinese Inbox
uses a project-scoped snapshot with one linked request outside the returned
card page. Both asks share the same topic key and count in the chip and More.
Select two identical shortened labels by project ID. Confirm a long request
title stays on its card and an unlinked legacy pick appears under Other and
All. Check the localized Payments label, the HyperNeo and API names, and the
fallback for another English title. Repeat with `VERIFY_THEME=light` and
`VERIFY_THEME=dark` in separate fresh runs and evidence directories.
The scoped RPC receipt and read-only SQLite output confirm the missing card
page entry and the original stored pick and project title.

Use `waiting-only` to check that Waiting on you lists only waiting cards. The
seed adds one finished ask. Waiting on you must show no held card, no uncovered
step and no scene section. In progress must still show the uncovered step and
Recent outcomes with the finished ask. Run it on the base, where it exits 1 with
the leaks it saw, and on the fix, where it exits 0. Compare
`waiting-only-<theme>.png` with `waiting-only-progress-<theme>.png`.

Use `late-reference` to open a chat link to a held question while its item is
missing from the browser's queue snapshot. A second hold refreshes the queue.
Verify that the Inbox clears the conflicting topic filter, selects Held, and
focuses the linked question when it arrives. The browser captures
`late-reference.png` and records the selected state in `human-queue-web.json`.

Use `phone-parity` for the phone's tab rules in the Chinese Inbox. The seed has
one ask per case: two open cards, a held card beside a stalled step, future
reminders, a 28-todo checklist with 26 done, a step the human paused, a step
Neo held until a deploy, a hold past its review date, a step after an earlier
step, a running and a queued session, a failed step and 12 filed outcomes. It
requires `等你 1 · 等待中 3 · 已搁置 2 · 进行中 1 · 所有工作 16`; 等你 lists only the
two cards, 等待中 the deploy hold, the later step and the queued session, 已搁置
the held card and the human's paused step, 进行中 only the running step.
Each 等待中 step reads its wait: Neo's reason, 等前一步完成 or 排队中, shown in
`phone-parity-others-*.png`. The checklist card reads `2 个待办`, and
显示更早的结果 under 所有工作 adds filed outcomes. Before the fix it exits 1 with
等你 7.
