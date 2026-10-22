# Explicit SDK tool and subagent disclosures (#8101)

Use shared isolated setup, synthetic data only and a fresh run. Build web first.
Keep the launch terminal alive; use a free port other than 8399:

```sh
RUN=$(mktemp -d /private/tmp/hn-sdk-tools-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-tool-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

The seed refuses an existing DB through the base fixture. It stores an ordinary
Read result, a subagent with nested Read/result/progress messages, and a final
Markdown output. No real provider, credentials, live transcript or model turn is
needed. Doctor must report usable.

In persistent headless Playwright with five-second locator timeouts, import
`sdk-tool-disclosure-web.mjs` and call
`verifySdkTools(page, { port, run, width, phase })` at 390 and 1280. Use `before`
on the reproduction and `after` on the rebuilt fix. The actual session begins in
compact mode; expansion fetches the daemon's full stored messages. Screenshots
only disable animation while capturing, after normal interactions.

| Claim / control | Actual browser check |
| --- | --- |
| Tool title is inert | Clicking Read leaves its result closed; only more opens it |
| Valid exposed panel relationships | Closed controls omit aria-controls; each expanded control points to its mounted panel |
| Tool keyboard focus survives | Enter opens, focus moves to less, Space collapses and focus returns to more |
| Selection does not toggle | Drag actual Synthetic tool text; selected bytes start Syn and details stay open |
| Subagent title is inert | Description click leaves prompt hidden; explicit Enter loads prompt and output |
| Hydration keeps the control | Focus remains on less after full prompt/output arrive; collapse returns focus to more |
| Nested Read stays independent | Its own more opens the nested result without closing the parent; body click stays open |
| Raw nested progress is explicit | Summary click stays closed, Enter on more opens JSON, body click stays open, Space closes |
| Bottom-right placement | Compare control/container right edges; the subagent less shares the short final paragraph |
| Phone / desktop fit | No horizontal page overflow; inspect controls, text, tool output and composer |

Inspect the viewport screenshots separately from JSON measurements, including
nested-tool output and raw JSON. Existing SDK suites retain progress, notification,
result-action, read-image, default-expansion and nested hydration contracts.
Never activate Remove From Context during this journey. Disabled expansion and
empty output stay covered by component contracts.

The structured-patch disclosure is only offered with `variant="detailed"`, which
has no runtime caller on this head. Its inert summary, explicit controls and
open/closed details are component-tested; no actual-daemon UI proof is claimed
for that unreachable variant. No iOS or live-provider coverage is claimed.

For long-output focus regression, seed a separate fresh run with `--long` after
its path. Import `sdk-tool-scroll-web.mjs` in the same persistent browser and call
`verifyToolScroll(page, { port, run, width, phase })` at 1280 and 390. It opens
200-line Bash output and a 100-paragraph subagent through Enter after scrolling up through later messages, records both
header positions and asserts the viewport stays put (within two pixels) while
the relocated less control retains focus below the viewport. Inspect screenshots
for the first lines rather than the final lines. This regression fails on the
old focus restoration at both widths. The regular journey still covers Space
collapse, restored focus and independent nested controls.

Close the browser and stop only this run with `stop.sh "$RUN"`. Preserve JSON,
before/after screenshots and doctor output in the PR. No shared SKILL.md or index
edits are needed.
