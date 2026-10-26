# Neo composer collapses when unfocused

Use shared isolation and launch setup in SKILL.md, including the resource
preflight. Build the web and launch an isolated daemon. Configure the synthetic
voice endpoint using journey 2 before running the browser helper, so the mic is
available. Use fake browser media only; no real microphone or speech service.

```bash
VERIFY_BROWSER=<installed-chromium> node .claude/skills/verify/composer-layout.mjs "$PORT" "$RUN"
```

`VERIFY_PLAYWRIGHT` optionally selects an existing Playwright package path.
The helper drives real `/neo` at 390px and 1280px. It checks that +, mic and send
share a row; both voice/send targets are at least 44px; their gap is at least
16px; focus expands the composer and reveals preferences; blur preserves a
multiline draft and collapses it; recording keeps the one-row height and 16px
gap. It saves three screenshots per width and `composer-layout.json`.

Inspect the screenshots for a 24px heavier mic glyph, readable text, spacing,
and no overflow. Native iOS parity must be checked separately against the iOS
implementation. A browser launch failure is not a layout pass: retain its error,
mark screenshots unverified, and leave browser proof pending. Do not bypass
host browser restrictions.
