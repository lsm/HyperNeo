# Explicit step and result disclosures (#8097)

Use the shared isolated setup, a fresh synthetic run, and a free port other than
8399. Build the web package before launch. Seed only the fresh run:

```sh
RUN=$(mktemp -d /private/tmp/hn-step-result-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/step-result-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

Keep the launch terminal alive. Run `doctor.sh "$PORT" "$RUN"`; it must say
`usable`. No provider credentials, real transcript, model turns or remote reads
are needed. The seed creates a consumed synthetic transcript and a work-card
link to it. The seed refuses to reuse a database through its base fixture.

Use persistent headless Playwright, explicit viewports and a five-second default
locator timeout. Import `.claude/skills/verify/step-result-disclosure-web.mjs` and
call `verifyStepResults(page, {port, run, width, phase})` at 1280 and 390, with
phase `before` on the reproduction and `after` on the rebuilt fix. The helper
uses the actual `/neo` work-card Open button (Your work drawer on phone), then
`/session/<worker>` and its compact/minimal/full view controls. It records JSON
and viewport screenshots in `$RUN/evidence/<phase>/`.

| Claim / control | Functional check | Visual state / evidence |
| --- | --- | --- |
| Step-list summary is selectable, not clickable | Summary click leaves details closed; Enter opens; Space closes | Neo collapsed/expanded, both widths |
| Tool and thinking rows use explicit shared controls | Only more expands; body click leaves less expanded | Nested rows expanded; all three control bounds in JSON |
| Bottom-right, final-line placement | Compare right edges and container bounds; inspect short thinking final line, long tool pre and outer footer | Neo expanded screenshots, both widths |
| SDK turn status stays inert | Status text click does not toggle; explicit control changes expanded state | SDK minimal status screenshot |
| SDK result summary/details stay inert | Summary click does not expand; explicit more opens, body click does not close, Space closes | SDK full collapsed/expanded screenshots |
| Selection is safe | Drag actual Short thinking ending text; selected bytes start with Short and row stays open | JSON selectedText |
| Phone fit | No document horizontal overflow; inspect complete controls and composer | All phone viewport screenshots |

Exploratory checks: expand nested tool/thinking rows before closing/reopening the
outer list; switch compact/minimal/full SDK modes; check unavailable tools have
no nonfunctional button in the component suite. Keep live clocks/counts, error
results and translated labels covered by existing component contracts. Inspect
screenshots separately for clipping, readability and excessive whitespace.
Other SDK thinking/tool/system disclosures are separate tracked slices; their
existing headers in the SDK screenshots are not claimed fixed here.

`NeoMessage`'s legacy work-report prop has no runtime caller on this head; its
explicit more/less, inert title/body, report contents and copy action are covered
by component contracts only. Do not claim an isolated-daemon report journey for
that unreachable prop. Native iOS and live-provider behavior are not verified.

Close the browser and stop only this run using `stop.sh "$RUN"`. Preserve the
before/after screenshots and JSON in the PR. Do not modify the shared SKILL.md.
