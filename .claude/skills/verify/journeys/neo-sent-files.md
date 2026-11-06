# Sent text files as cards

Follow the shared setup and resource guards in SKILL.md. Build the current web
checkout and run from the repository root with existing NODE_PATH and
VERIFY_BROWSER dependencies as described there.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-sent-files-web.mjs
```

The existing launcher owns an isolated, keyless test daemon and browser pairing,
uses random ports excluding 8399/8499, saves logs, stops servers, and deletes the
fresh synthetic home and database. It now accepts a browser helper so the file
journey shares the photo journey's setup. Failed assertions or launches fail the
proof. Preserve any unsaved retained run before retrying.

At 1280px and 390px the browser sends a synthetic UTF-8 file with words, then
alone. Require a compact, right-aligned card above the words, no file source in
the bubble, and no bubble for a file alone. Both messages still offer Copy and
Reply. Open the card and require its original filename and exact selectable plain
text, including literal HTML, backticks and Chinese text. Escape dismisses it.
Reply quotes the words when present and the original message for a file alone.
Inspect the saved screenshots and layout observations.

The pure/component regressions cover the web writer's escaped names and fences,
the actual voice suffix combiner, the phone writer form, malformed input retained
whole, pending failure recovery, session user cards, and original-message Copy.
The phone reference is the approved sent-file patch f803f7fd, checked against
phone main 6417a79c before this slice. Re-check it before media flight work.
