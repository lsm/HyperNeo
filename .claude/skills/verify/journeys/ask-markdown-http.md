# Open a paired work card as Markdown

Use the shared resource guard, fresh HOME/data isolation and cleanup in SKILL.md.
Run from the checkout root.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/ask-markdown-http.ts
```

The helper seeds one synthetic card with a todo, an open choice question, an
answered question and an outcome. It reads the public entry through the real
`neo.ask.read` WebSocket operation and compares its fields with the HTTP Markdown.
An unpaired GET must return 401 with `Device pairing required` and the
`hyperneo read <link>` hint. Paired bearer
and cookie requests return Markdown with `Cache-Control: no-store`. Pairing uses
the production POST /pair endpoint and its browser cookie response. An unknown
card returns 404. The existing ordinary GET /ws remains authenticated with 204.
Private completion wording and answered questions are absent from the Markdown.

The helper then stops the standalone daemon and runs the production, embedded
production and development CLI entrypoints sequentially against that synthetic
database. Each public listener must produce the same results.
The helper reads the advertised local origin from each CLI's own output and
passes its card link to the real `hyperneo read` command. All three commands must
print the card successfully, with the advertised host matching the issuer's
canonical host rule.

Embedded assets are build-generated, so the proof temporarily supplies an empty generated asset
module in the owning checkout and removes it afterward. It refuses to overwrite
an existing generated module. The real embedded HTTP handler runs unchanged.
The development entrypoint runs its actual Vite server. All child daemons and
Vite servers must stop before the wrapper saves evidence and removes the data.
Wait for the source CLI start function to return before testing its listener.
The helper's ready marker distinguishes the public server from the temporary
internal daemon listener that the CLI replaces during startup.

Each public entrypoint also accepts its startup-created agent credential on the
card GET and rejects ten other route/method combinations, including /ws, public
assets, peer routes and POST/HEAD/OPTIONS on the read page. The credential is
different from the human one. The agent-read-pages journey additionally verifies
the real CLI, human-approved remote pairing and persistent revocation.

Inspect `observed.json`, `rpc-card.json`, the four Markdown files and the CLI
logs. The final receipt must say `passed` and `allServersStopped`. The baseline
reproduction fails on the standalone GET with 404 instead of 401.

For the browser authentication prerequisite, run `browser-http-auth-gate.ts`
with a fresh control-directory argument through the same proof wrapper. Open
the URL in its control `browser.json` using the approved browser. Check ordinary
GET before pairing, pair with the fixture button, then check GET again. The
browser must observe 401, 200 and 204, with no credential in the pairing JSON.
Save the observations and screenshot into the helper's evidence directory and
write its done marker. This uses a production pairing cookie on an ordinary
same-origin GET and no credential in the URL. The fixture page is test-only.
