# An expanded composer keeps its size through one Reply press

Open root and configure the mock provider as SKILL.md describes, then run
`NODE_PATH=<directory containing playwright> node .claude/skills/verify/quote-expanded-click-check.mjs <port> "$RUN"`.
The check seeds one synthetic publication per run and pairs a browser through
`/pair` with an owner-issued human code. It focuses the empty composer and
presses Reply to Neo's message three ways: a fine-pointer press held down and
released, a tap at 390px with `hasTouch` (asserting `(pointer: coarse)`), and a
touch press held through CDP `Input.dispatchTouchEvent`. Each run asserts the
pointer type the page received.

End state: the composer stays expanded while a press is down, the first press
adds the quote bar, and the composer keeps its expanded size. Before the fix the
composer collapsed on `focusout` during the pointer press, the layout moved
about 60px and the click missed, so a second press was needed; the fine-pointer
run is the one that shows this (48px and no quote before, 108px and one quote
after). `evidence/quote-expanded-click.json` records the pressed height, the
observed pointer events and the quote count per run, with one screenshot each.
No provider turn is used.
