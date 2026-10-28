# Round mic hover, press and focus inside the capsule composer

Use SKILL.md for the resource guard, build, isolated HOME/data and cleanup.
Run proof-run.sh with neo-composer-mic-shape.ts, before|after and a ready JSON
path. The helper owns a real metadata-only daemon and synthetic Neo/session
composers, enables voice only in its fresh DB, and refuses external HTTP.
There is no provider, model or speech service.

In headed Playwright launch Chromium with --use-fake-ui-for-media-stream and
--use-fake-device-for-media-stream. Grant microphone permission to each context;
this is synthetic browser audio, never the physical mic. Import verifyMicShape
from neo-composer-mic-shape-web.mjs and pass {phase,theme,touch,evidence} at
1280x900 desktop and 390x844 touch in both light and dark themes.

Before records the small-radius rectangular hover/focus surface inside the
rounded composer. Commit the failing browser reproduction before changing the
button. After requires fully rounded corners and at least 44px target dimensions
at rest/hover, keyboard focus and native pointer-down. Both Neo and the session pane
must start recording on the first press and Enter, then cancel without sending.
Hover covers the empty capsule; focus and pointer-down use the expanded composer.
The browser clicks/taps the target directly and samples its pointer-down event
rather than holding a raw coordinate across a responsive layout transition.
Inspect the saved screenshots for the rounded hover/focus surface and recording,
readable icons, a visible keyboard focus ring and no layout jump. The ordinary
composer sizing/recording journey remains neo-composer-focus-layout.md.

Write browser.json with phase and baselineReproduced (before) or passed (after)
after reviewing all four theme/layout cases. Close owned browser contexts,
signal the helper PID with SIGUSR1 and require wrapper exit zero. Preserve
evidence; the wrapper removes synthetic data. Run the existing Voice/Composer
tests, build and full check. After merge, verify a containing served build and
hover/focus in the explicitly permitted read-only live UI; never record live or
restart the daemon. Live speech capture/transcription is not claimed.
