# Durable quote text for answered or retired Neo cards

Follow shared isolation in ../SKILL.md. No provider, credentials, simulator,
physical phone or live daemon is required. Run the real RPC proof with a fresh
absolute evidence directory:

```
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /private/tmp/neo-card-quote-proof .claude/skills/verify/neo-card-quote.ts
```

The helper owns an ephemeral daemon and refuses gh access. It creates a synthetic
choice question, its replacement and a legacy ID-only reply. Sending a real human
reply answers the replacement. The actual WebSocket history read must include
Neo's author and the replacement text on that sent bubble, and retain an ask-card reply through the web history parser. Independently
resolve the retired original's text on the legacy bubble. The legacy payload
must remain byte-for-byte unchanged. Keep card-quote.json and proof.log; all
sockets/processors/daemon resources close in finally and the wrapper removes data.

Before the fix the same RPC proof fails because the sent quote contains only
kind and id. Focused intake contracts cover question, todo and ask cards, question
replacement/answer, duplicate delivery, ordinary publications, human messages,
excerpt bounds and missing originals. The web ReplyQuote regression renders the
actual returned shape with no work-card labels loaded. iOS already decodes the
same author/excerpt fields and uses them as its missing-card fallback; native
phone rendering is not verified by this daemon proof and requires its owner.

Build packages/web first to exercise the actual UI too. Set NODE_PATH to an
existing directory containing playwright and playwright-core, VERIFY_BROWSER to
an installed Chrome executable, and run the same wrapper with a new evidence
directory. The helper serves that build and the real socket on a second ephemeral
listener. Inspect card-quotes-402.png and card-quotes-1280.png: all three sent bubbles
must show Neo and the correct distinct question text, never unavailable. web.json
records the rendered text. The browser, static listener and daemon close even on
failure. This proves web rendering at touch/desktop widths, not native iOS.
