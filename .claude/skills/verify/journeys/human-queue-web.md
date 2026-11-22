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
its state and ask rows, including More. Hold moves a question to Held, Take back
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
