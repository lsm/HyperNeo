# Open the exact session named by a publication

Use SKILL.md's resource guard, isolated proof wrapper and installed browser paths.
Build web for this checkout first. Run:

```sh
NODE_PATH=<existing Playwright modules> VERIFY_BROWSER=<Chromium executable> TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/publication-open.ts after
```

The helper owns an ephemeral daemon/frontend, synthetic HOME/DB and refusing gh.
No model/provider or live daemon is used. It publishes through the real Neo MCP
door: local worker, Space task-agent, Codex-qualified, Claude-qualified
a link-less native session, and no-session replies, plus Neo's own session and a
stored row that already names it. Existing
work.status metadata is scripted only for the two native adapters; local work
uses the real driver. Native URL resolution uses the same card source reader.

In desktop and touch layouts, light and dark, Open must appear once at each
session-bound message's top-right, with the same work-card control/logo. It must
open each exact local session pane, including Space task-agent sessions
that the worker inventory intentionally excludes, then return to Neo without
losing the reply. A reply naming Neo's own session, published or already stored,
must have no Open.
Native links are captured at window.open to avoid launching human apps; do not
claim actual native Desktop launch. A reply without session has no Open even if
it has origins or work links. Retain screenshots and browser.json, inspect for
clipping. A known native session with no app link must show a disabled, visibly
dimmed Open with an unavailable tooltip, without inventing a URL. Require the wrapper's zero exit plus resourcesClosed:true.

The before phase records the missing controls in the same real browser surface.
The helper closes browser contexts, frontend and daemon in finally. The wrapper
preserves evidence before deleting temporary HOME/DB. Also run publication and
work-card component tests, the Neo operation tests and bun run check.
