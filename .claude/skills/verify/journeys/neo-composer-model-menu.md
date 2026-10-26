# Neo composer model menu picks Neo's model and thinking

Follow shared isolation setup in SKILL.md. Build the web first
(`bun run --cwd packages/web build`), then run the headless helper with a fresh
run directory and two free ports, never 8399:

```bash
NODE_PATH=<playwright node_modules> VERIFY_BROWSER=<chrome binary> \
  bash .claude/skills/verify/neo-model-menu.sh /private/tmp/hn-neo-model-menu-UNIQUE 9395 9396
```

The launcher starts an `env -i` daemon with `NODE_ENV=test`, a fresh HOME, data
dir and DB, and a local mock Anthropic API. The helper creates the synthetic
Anthropic provider on that daemon only, saves Sonnet with a 70% auto-compact
percent as Neo's starting model, then drives `/neo`:

- Focus the message field to expand the composer and reveal preferences.
- The composer's "Model and thinking" menu lists models and a Thinking slider.
  It has no link and no Restart Neo.
- Moving Thinking to 16K and then picking Haiku are read back from
  `neo.snapshot` preferences (`neo.preferences.set`), not a per-session switch.
  The thinking-only change keeps Sonnet's saved 70%.
- After reload at 1280px and 390px the menu shows Haiku selected and fits the
  viewport.

Evidence: `$RUN/evidence/neo-model-menu.json` and
`neo-model-menu-{1280,390}.png`. This proves the saved preference, not a real
provider's next-turn switch; that runtime path is unchanged by this journey.
