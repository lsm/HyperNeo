# Source-bound worker handoff reader

Run `proof-run.sh` with `card-handoff-read.ts` from a fresh checkout. The helper
starts an isolated daemon, publishes a synthetic HTML handoff through the worker
MCP operation, and seeds its path-free reference on a synthetic question and
publication. It reads both through the paired local-user RPC door, verifies HTML
sanitization and the absence of internal paths, and checks forged references,
missing sources, and tampering. It closes the daemon and removes its temporary
data. Focused `card-handoff-read.test.ts` additionally exercises Markdown, foreign
owners, worker denial, source removal during a read and version-bound chunks.

For web proof, build the current checkout's web app, then add `--browser` and a
fresh absolute control directory to the helper invocation. Open the local
proof-entry in an isolated browser at desktop and narrow widths. Open the worker
file on the question card; check the sanitized HTML in the empty-sandbox iframe,
the disabled-script notice, and the absence of internal paths. Save screenshots
after animations settle, write `{ "passed": true }` to `browser.json` in the
run's evidence directory, and create the control directory's `done` file.

The helper seeds the stored reference directly because publication and question
writers do not yet accept handoff references. This does not prove card writing
or the separate iOS client.
