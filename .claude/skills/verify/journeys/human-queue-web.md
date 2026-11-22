# Queue filters and attachment hover in the Neo Inbox

Use the pinned runtime, resource guard and isolated daemon setup in ../SKILL.md.
Build the web bundle at the checked-out head, then run the desktop web journey:

```sh
VERIFY_BROWSER=<chromium> VERIFY_PLAYWRIGHT=<playwright-package> VERIFY_MOCK_PORT=29347 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/human-queue-web.sh \
  29346 <before-or-after> <absolute-evidence-directory>
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
