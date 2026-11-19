# Allow desktop control from a card

Build web from the checkout, then run:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=<directory containing playwright> TMPDIR=/private/tmp \
  bash .claude/skills/verify/desktop-control-card.sh /absolute/evidence/dir
```

The isolated daemon seeds synthetic todos, opens a desktop control card through
`neo.question.ask`, and pairs a synthetic human browser. The helper captures light
and dark screenshots at wide and phone widths, then replies in chat and taps Allow. The chat reply must leave the card open and control off. Pass requires the
card to name the todo and app, close after Allow, and `named.txt` to show desktop
control enabled for the named todo only. `status-before.json` and
`status-after.json` record worker opt-in. No desktop driver runs.
