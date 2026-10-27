# Open questions on collapsed ask cards

Use the shared isolated setup with a fresh run directory and free daemon/mock
ports, build web, launch, and run doctor. Run:

```sh
NODE_PATH=/opt/homebrew/lib/node_modules/@playwright/cli/node_modules \
  node .claude/skills/verify/neo-open-questions.mjs "$PORT" "$RUN"
```

The helper seeds a synthetic ask and creates two questions over RPC. At desktop
1280 and mobile 390 widths, both questions and enabled answer buttons must appear
without expanding the card. Expanding then collapsing must preserve both questions.
At mobile width, answer both through the UI and confirm each persisted human answer
via RPC, with no question left visible after the last answer. Evidence includes
screenshots and open-questions.json under the run's evidence directory.
Stop only the owned daemon/mock and preserve evidence before removing the run.
