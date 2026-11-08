# Composer parity: visual tokens and frame

Use pinned Bun and shared resource preflight from SKILL.md, install frozen
dependencies, and build the web at the checked-out head. Then run:

```bash
VERIFY_BROWSER=<installed-chromium> VERIFY_PLAYWRIGHT=<playwright-package-path> \
VERIFY_MOCK_PORT=19347 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/composer-frame.sh 19346
```

The wrapper launches an isolated daemon and mock, pairs a synthetic browser,
and enables fake streaming dictation. No real microphone, speech service or model
turn is used. Both themes run at 390px touch and 1280px desktop. Verify the idle
capsule keeps its border and 48px height; an expanded blurred draft has a transparent
border and the 6px/32px/12% shadow; focus and recording use the accent border.
Token receipts cover send, send foreground, control fill and danger in both themes.
Review all screenshots for clipping and contrast. Recording is cancelled without
sending; both owned processes must stop. Keep composer-frame.json and screenshots.
The matrix also checks one control row, centered status above it, horizontally scrolling attachments, hidden recording tools, flat 40×32 recording Stop, the inert realtime voice icon and growing/scrolling live words. Dictation cap/count direction, cancellation while transcribing, Stop/Send switching and question-driven expansion remain a separate behavior change.

The same matrix also checks a 44x32 send face inside its 44x44 target, full
opacity while empty Send is disabled, and a 32px model pill with 14px text and
control-fill background. Before/after screenshots live in separate run dirs.
For a baseline capture, run `python3 .claude/skills/verify/composer-frame-before.py`
with the same browser/mock environment. It preserves current bytes of the composer
source files, builds them from the fetched origin/dev, captures phase=before,
and restores every file in finally. Rebuild the current web afterward. The
source backup path is printed and retained if the process is interrupted.

The wrapper also bundles the real NeoComposer with synthetic quote, bound-preview,
replacement-preview and deferred File.text() reading states. Its assets are served
by the isolated daemon's existing guarded static route; no extra listener or
production fixture route is added. Both themes and widths require every auxiliary
row to keep a 17px frame inset. A 9px receipt reproduces missing child padding.
Auxiliary screenshots are retained. This component-state fixture verifies layout,
not artifact capture or file-reading completion; the ordinary matrix still drives
/neo and cancels fake dictation.

Jason review regressions are covered by composer-review.mjs: the pending pill
uses the mock's compact flex column, Send has only the face ring under keyboard
focus, Stop has a 44x32 radius-10 face in a 44px target, and collapsed recording
has 6px top/bottom padding. The scoped turn-control focus rule is required because
the unlayered global button outline overrides Tailwind's layered outline utility.
The microphone retains its existing focus styling.

To refresh an exact pre-review baseline, set VERIFY_COMPOSER_BASE to its full
commit SHA and VERIFY_REVIEW_ONLY=1 for composer-frame-before.py. A failing
review receipt is expected on the old head; all source bytes are restored.
Rebuild and run the current full journey afterward. Build the phone-safe comparison
with `node .claude/skills/verify/composer-comparison.mjs <mock-overview.html>
<before-evidence-dir> <after-evidence-dir> <absolute-output.html>` using the same
browser environment. Every image is embedded; inspect the comparison against the
mock directly. It labels the remaining behavior differences.

Composer radius/shadow use @theme control/composer tokens. Send/foreground use
@theme inline semantic colors with global accent fallbacks and Neo overrides.
The geometry/color receipts must stay identical when replacing literal utilities
with those named tokens. No new arbitrary color/radius/shadow classes belong in
composer markup.

The final glyph/text size receipts require a 14px turn-stop glyph and an 11px
pending notice, with the notice using the named text-2xs theme utility. The send
arrow stays 18px using the existing size-4.5 spacing utility.

For the thinking-level focus regression, run `composer-thinking-click.sh 19346`
through the same with-run.sh wrapper and browser environment. It seeds only the
isolated model preference, opens the empty composer, and clicks the native range
input once at 390/1280px. The saved preference must change without hiding the menu
or modifying the draft; closing the menu and clicking outside must still collapse
the empty composer. Before the fix, disabling the slider during save removes focus
and incorrectly collapses the composer. Keep thinking-click.json and screenshots.

The thinking regression must also compare the visible slider label against the
pill after one click, drag the thumb through several steps without a save until
release, and use an arrow key. Preact compat remaps JSX onChange to input; the
slider deliberately uses native change capture to commit on release. The component
regression loads compat and dispatches an actual native change event (the testing
library compatibility helper otherwise rewrites fireEvent.change back to input).
