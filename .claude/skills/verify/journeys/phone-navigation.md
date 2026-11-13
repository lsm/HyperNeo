# Phone navigation has no bottom tab bar

Follow SKILL.md isolation and resource checks. Build the current web checkout, then
run `bash .claude/skills/verify/bottom-nav.sh /absolute/evidence-directory` from the
repository root. Supply NODE_PATH for existing Playwright dependencies and
VERIFY_BROWSER for an installed headless Chromium when needed.

The helper owns a keyless test daemon on random ports, excluding 8399. It pairs a
synthetic browser through the real device flow, creates one session and one Space
over RPC, and visits chats, settings, a session and a Space at 390x844 with touch
emulation and a coarse pointer. All browser traffic stays on that isolated
daemon's origin. It saves screenshots, the collected nav observations and daemon
logs before stopping its owned servers and deleting their temporary data. A failed
browser launch or assertion is a failed proof.

Require no bottom tab bar on any phone surface: `[data-testid="bottom-tab-bar"]`
must be absent from `/sessions`, `/settings`, `/session/<id>` and the Space views,
and the chat composer must stay inside the viewport. Every surface's header must
carry the navigation menu button, whose drawer reaches Chats and Settings; tapping
Settings must land on `/settings`. Inside a Space, the drawer lists Overview, Tasks
and Agents, and Tasks opens the tasks view. Inspect the screenshots for a phone
layout with no leftover bottom padding.
