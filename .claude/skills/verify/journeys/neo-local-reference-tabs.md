# Neo publication local paths retain the docked preview tabs

Run the component regression check from the repository root, using existing
dependencies (no install):

```bash
bash .claude/skills/verify/reference-tabs-check.sh
```

The publication fixture deliberately has no registered attachments. Click the
inline-code home-relative HTML path, then repeat with the plain absolute path
in expanded full details. While resolution is pending, require a selected path
tab and the Work tab in the actual ArtifactPreviewPanel. A refusal must keep
those tabs and show "This file is no longer available to you." in the selected
tabpanel, without the legacy Preview heading or Back button. The exact source
publication and clicked reference must reach the resolver.

The NeoLive check separately requires the docked layout and working Work-tab
navigation after refusal. Existing checks cover successful promotion into file
tabs, reused viewers, PR changed-file Back navigation, and phone result mode.
These are happy-dom component checks with synthetic RPC replies, not browser,
real-file authorization, geometry, or theme proof.

For browser proof, use the shared isolation and cleanup in SKILL.md and the
existing in-app-previews-web-taps journey. In its synthetic publication, click
the inline notes path rather than the registered attachment card. Also publish
a path-only reply with no authorized file context, using the isolated daemon's
neo.publication.publish operation and a synthetic human ask as its origin.
Click its inline-code path and its plain path in expanded details. At 900px,
require the chat beside the panel, selected path tab, Work navigation and the
unavailable message; successful paths must promote into ordinary file tabs.
Repeat in light and dark, save screenshots and panel/chat bounds, and check
390px still uses the phone result sheet. Stop and remove the isolated run after
saving evidence. Browser proof remains pending if headless launch or local
origin access is denied; do not count the component checks as a substitute.
