# Sent photos above the words

Follow SKILL.md isolation and resource checks. Build the current web checkout,
then run `bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory`
from the repository root. Supply NODE_PATH for existing Playwright dependencies
and VERIFY_BROWSER for an installed headless Chromium when needed.

The helper owns a keyless test daemon and mock on random ports, excluding both
8399 and 8499. It pairs a synthetic browser using the real device flow and sends
a synthetic PNG with words, then alone, through the real composer at 1280px and
390px. All browser traffic stays on that isolated daemon's origin. The helper
saves screenshots, layout observations and daemon logs before stopping its owned
servers and deleting their temporary data. A failed browser launch or assertion
is a failed proof. Retained unsaved runs must be handled before retrying.

Require photos above the words bubble and right-aligned, at most 256px high.
Photo-only sends have no bubble, dummy words or Reply action, and Copy is disabled.
Keyboard activation opens the full-size lightbox. Tab stays in it, Escape closes
it, and focus returns to the photo. Inspect both widths' screenshots.

Component regressions additionally cover pending sends, failed-send Retry/Edit,
quoted and preview-reference bubbles, session-pane user photos and the existing
composer lightbox's dismissal and focus behavior. Neo's own photos keep their
bubble. The message payload is unchanged, including the existing photo-only
`Attached files` placeholder.
