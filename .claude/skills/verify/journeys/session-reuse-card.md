# Session reuse choice card

Build the web client and use the isolated Launch setup in `../SKILL.md`. With the
daemon running and `HYPERNEO_DATA_DIR` set to the run data directory, run:

```sh
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<Chromium executable> \
  bun .claude/skills/verify/session-reuse-card-web.mjs <port> "$RUN"
```

The helper creates a synthetic ask and asks for the core reuse preference through
the daemon. It pairs a fresh headless browser, opens the actual Neo card at mobile
width, checks its descriptions and absence of tables, and selects one session per
matter. The daemon must report `per_ask`. Evidence is
`evidence/session-reuse-card.json` and `evidence/session-reuse-card.png`.
