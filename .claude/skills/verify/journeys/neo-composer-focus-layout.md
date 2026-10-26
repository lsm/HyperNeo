# Neo composer uses a compact empty capsule

Use shared isolation and resource preflight in SKILL.md. Build the web, then run
this wrapper from the repository root with a fresh absolute evidence directory:

```bash
bun run --cwd packages/web build
VERIFY_BROWSER=<installed-chromium> VERIFY_PLAYWRIGHT=<playwright-package-path> \
  bash .claude/skills/verify/composer-layout.sh /absolute/fresh/evidence-directory
```

The wrapper owns a synthetic HOME/DB, an isolated metadata-only daemon and a
loopback ASR fixture. It uses fake browser media, no real microphone, credentials,
provider/model or speech service. Optional second argument selects a free daemon
port (default 9374); its ASR uses the next port. Neither can be 8399. It stops and
waits for its children, retains evidence and logs, and deletes its temporary data.

The helper drives real /neo at 390px and 1280px. An empty, unfocused composer must
have no Send button, a height about 48px, centered at about 83% of the column
width, fully semicircular ends, + and placeholder on the left, and mic on the right with usable 44px targets. Focus expands the composer and
reveals preferences; a blurred multiline draft stays expanded and unchanged.
Clearing and blurring restores the capsule. First-click attachment and mic
actions must work without focus expansion moving the target before activation.
Unfocused empty recording retains its previous full-width 78px row; idle capsule
sizing does not apply to recording. Recording keeps mic/stop and send
controls 16px apart, measured together after the parent enters recording state.
With voice disabled, the capsule has + and placeholder with no mic or Send.
Screenshots and composer-layout.json are retained.

Inspect screenshots for readable text, a heavier mic glyph, capsule proportions
and no overflow. Native iOS parity needs separate inspection of its implementation.
A browser launch failure is not a layout pass: retain its error, say screenshots
are unverified and leave browser proof pending. Do not bypass host restrictions.
