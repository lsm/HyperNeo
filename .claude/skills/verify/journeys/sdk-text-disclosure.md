# SDK thinking and synthetic text disclosures (#8100)

> Historical migration journey: legacy rendering has been restored. For current
> legacy verification use [legacy-chat-compact.md](legacy-chat-compact.md); the
> explicit-more assertions below describe the superseded migration, not current behavior.

Use shared setup with synthetic data only, a fresh run and a free port other than
8399. Build the web package before launch. Keep the launch terminal alive:

```sh
RUN=$(mktemp -d /private/tmp/hn-sdk-text-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-text-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

The seed refuses an existing DB through its base fixture. It stores a synthetic
consumed transcript with short and long final reasoning lines, plus a long
Markdown synthetic message. No provider, real keys, model turn or remote read is
needed. `doctor.sh "$PORT" "$RUN"` must report usable.

In persistent headless Playwright, import `sdk-text-disclosure-web.mjs` and call
`verifySdkText(page, { port, run, width, phase })` at 390 and 1280. Use `before`
on the failing reproduction, then `after` on the rebuilt fix. Use a five-second
locator timeout. Screenshots disable animation only for capture, after the normal
keyboard/click interactions; finite animation wait promises could stall during
view-mode transitions, so the helper waits for fonts and captures the settled
layout directly. The helper opens the actual session transcript, uses its view
mode controls and reloads after switching to full mode so its full transcript
projection is loaded. It records viewport screenshots and JSON under
`$RUN/evidence/<phase>/`.

| Claim / control | Observable proof |
| --- | --- |
| Folded thinking header is inert | Title click leaves the pre hidden; Enter on more opens, Space on less closes |
| One control opens folded thinking fully | Full stored reasoning is visible after expansion, without a second nested expander |
| Full-mode thinking keeps its six-line preview | More opens, body click leaves it open, less returns to preview |
| Short last line shares the footer | Control and final text bottoms align within five CSS pixels |
| Long last line can use a new line | Desktop long ending forces the control below the text, right aligned |
| Synthetic Markdown uses the shared control | Enter expands and keeps focus on less after it moves to the paragraph; Space collapses and restores focus to more; paragraph click does not collapse |
| Selection is safe | Drag actual Short ending text and verify selected bytes and unchanged expansion |
| Desktop / phone fit | No horizontal page overflow; inspect footer, clipped preview, text and composer |

Inspect screenshots independently of the metrics, including both full thinking
endings, compact thinking, and expanded synthetic text. The component suite also
checks thinned-content lazy reads (only explicit expansion calls onOpen), plain
text synthetic rendering, native keyboard focus, copy/route details, empty and
short content, and running indicators. Synthetic mixed non-text blocks retain a
separate trailing footer; do not claim a browser journey for that variant.

No iOS, live provider, live transcript or interactive HTML coverage is claimed.
Close the browser and stop only this run with `stop.sh "$RUN"`. Preserve evidence
in the PR; do not edit the shared SKILL.md or an index.
