# Approved Neo quote controls

Follow SKILL.md for the current web build, isolated daemon, resource checks and
cleanup. Reuse the markdown-quote-colours journey's synthetic publication and
pair the browser through `/pair` using an owner-issued synthetic human code.
Import `verifyQuoteActions` from `neo-quote-actions-check.mjs` into the persistent
Playwright session. Supply its page and `{run,base,phase,theme,touch,baseline}`.
Grant clipboard-read/write permissions. Baseline is the matching before result.

Run before and after in dark and light at 1280x900 with a fine pointer, then at
390x844 with hasTouch true. Inspect viewport and article screenshots. The helper
requires the approved text colours, italics, 6% quote overlay and AA contrast.
It observes the deeper border, 64x48 fine-pointer quote copy, 64x44 coarse-pointer
quote copy (matching the mockup), 44x44 footer controls and 20px icons, plus a 5% foreground hover overlay with a stable quote background.
It exercises keyboard focus, Enter-to-copy, visible copied feedback, exact real
clipboard text, whole-message copy and Reply. Gold headings and message-reference
colours must match the baseline. Also check 320px touch width for control/text
overlap and capture a viewport screenshot. No provider turn is needed.

First run the after expectations against baseline assets and retain the failing
assertion, then commit the reproduction before applying the approved CSS. Rebuild
and repeat, retaining the four before/after screenshots for the PR. The existing
message-touch-target journey's desktop 28px assertion describes other controls;
quote/message footer copy and reply now use this journey's approved sizes.
