# An expanded composer keeps its size through one Reply press

Open root and configure the mock provider as SKILL.md describes, then run
`NODE_PATH=<directory containing playwright> node .claude/skills/verify/quote-expanded-click-check.mjs <port> "$RUN"`.
The check seeds one synthetic publication, pairs a browser through `/pair` with
an owner-issued human code, focuses the empty composer and completes a
human-paced press (down, a pause, up) on Reply to Neo's message at 1280x900 and
390x844 touch.

End state: the composer stays expanded while the pointer is down, the first
press adds the quote bar, and the composer keeps its expanded height. Before the
fix the composer collapsed on `focusout` during the press, the layout moved
about 60px and the click missed, so a second press was needed. `evidence/
quote-expanded-click.json` records the pressed height and quote count per width,
with one screenshot each. No provider turn is used.
