# Explicit SDK system diagnostics and raw JSON (#8179, part of #8102)

Use the shared isolated setup with synthetic data and a fresh run. Build web
first; no provider/model turn is needed. Never use 8399 or a live DB:

```sh
RUN=$(mktemp -d /private/tmp/hn-sdk-system-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-system-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

The seed delegates fresh-DB refusal to the base fixture, then stores synthetic
memory, 100-line hook output with stderr/exit code, compact metadata, unknown JSON
and later chat history. Doctor must say usable. Keep launch's shell alive.

In persistent headless Playwright, import `sdk-system-disclosure-web.mjs`, then
call `verifySdkSystem(page, { port, run, width, phase })` for 1280 and 390, with
five-second locator timeouts. Use `before` on the original title-toggle version
and `after` on the rebuilt fix. The helper drives the real session route and full
stored messages through the daemon; no network replies are replaced.

| Claim | Check and visual state |
| --- | --- |
| Titles are inert | Clicking Memory recalled, hook name, Compact and Show raw data leaves details closed; capture title screenshots |
| Explicit keyboard control | Enter opens and focuses less; Space on the explicit control closes and restores more |
| Details remain readable | Memory path, full hook stdout/stderr/exit code, compact JSON and unknown payload are preserved |
| Selection never toggles | Click and drag real detail text; record selected bytes and confirm expanded state |
| Long output keeps place | Scroll up through history, open hook output, retain header position within 2px despite focused footer below viewport |
| Bottom-right control | Compare footer/container right edges and inspect open screenshots |
| Phone/desktop fit | No document horizontal overflow at 390/1280; inspect composer and diagnostic text |

Inspect screenshots independently from the JSON measurements. The open screenshot
intentionally scrolls to the footer *after* recording the unchanged opening
position. Screenshots disable animation only during capture, after normal input.
The component contracts retain minimal-mode activity filtering and stderr/status
content. Initialization variants remain in #8180; no initialization behavior is
changed or claimed by this journey. Native iOS and live-provider traffic are not
covered.

Keep before/after JSON, screenshots and doctor output in the PR. Close the owned
browser, stop only this run with `stop.sh "$RUN"`, and retain the synthetic run
for evidence. No shared SKILL.md or journey index edits.
