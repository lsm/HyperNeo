# Project filters and attachment hover in the Neo Inbox

Use the pinned runtime, resource guard and isolated daemon setup in ../SKILL.md.
Build the web bundle at the checked-out head, then run the desktop web journey:

```sh
VERIFY_BROWSER=<chromium> VERIFY_PLAYWRIGHT=<playwright-package> VERIFY_MOCK_PORT=29347 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/human-queue-web.sh \
  29346 <before-or-after> <absolute-evidence-directory>
```

This seeds five asks across two projects in a fresh synthetic DB. A trip has one
waiting card, one held card and uncovered work. No provider or model turn is used.

Before must exit 1 with both themes reporting the two legacy filter rows and
the oversized attachment hover. After must exit 0. All and the two project
chips remain functional. Waiting cards, held cards and in-progress work are
accessible together, Hold and Take back both work, and the attachment button
opens the file picker. Its 44px target centers a 32px circular hover face
around the plus inside the collapsed composer.

Inspect the individual light and dark PNGs for each phase. The screenshots and
geometry receipts are captured from the paired desktop-width web UI.
