# Passive Claude Desktop window evidence

This is an explicitly requested, single-window read, never a GUI-driving test.
Do not launch, activate, focus, move, click or type into any app. Do not use
Accessibility, a display capture, a TCC edit, a permission request, or a fallback
through a denied path. Only the existing Screen Recording grant may be used.
No daemon, provider key, credential file or port 8399 is needed.

## Build and fake-API tests

Requires macOS 14 or newer and Xcode command-line tools:

```bash
PACKAGE=.claude/skills/verify/window-capture
swift test --package-path "$PACKAGE"
swift build --package-path "$PACKAGE"
CAPTURE="$(swift build --package-path "$PACKAGE" --show-bin-path)/capture-window"
```

Tests inject a capture API: permission refusal never lists windows, missing or
ambiguous matches never capture, owner/title/id all match exactly, capture and
output errors leave no new image, and existing evidence is never overwritten.
CI runs only these fake tests and compiles the native API; it never captures.

## Capture one named existing window

Use the owning app's bundle identifier, plus its exact window title and/or ID.
If both title and ID are supplied, both must match. A session title in the
conversation is not necessarily the OS window title. Use read-only window
metadata when the ID is known; never choose the first match or another app.
For Claude the app bundle identifier is `com.anthropic.claudefordesktop`.

Choose a fresh output leaf inside your evidence directory; it must not exist.
Replace the example ID with the window selected for this verification:

```bash
printf '%s\n' '{"appBundleId":"com.anthropic.claudefordesktop","title":"Claude","windowId":181,"evidenceDir":"/absolute/evidence/run-unique/desktop-window"}' |
  "$CAPTURE"
```

The helper accepts one JSON request on stdin. Success returns `ok:true`, `png`
and `record` paths. The fresh directory contains only window.png and window.json:
appBundleId, windowId, exact title, UTC timestamp and pixel size. Inspect the PNG.
It uses ScreenCaptureKit's desktopIndependentWindow filter, without a cursor or
sound, so no other window or display is captured. It does not change input/focus.

A missing grant returns permission_missing without asking for access. Missing or
ambiguous windows return window_not_unique. Other capture/output errors return
ok:false with code/detail and a nonzero exit, no published image and no substitute
window. Stop on refusal. Do not ask the human for a screenshot or try another
capture backend. Existing evidence is preserved; choose another fresh output
leaf only when appropriate, never overwrite it.

## Compare rendering with transcript evidence

1. Identify the selected Desktop session from what the captured window actually
   shows. If it is another session, hidden, blank or unreadable, record
   `ui-unconfirmed`; do not switch the UI to manufacture confirmation.
2. Use the authorized session's receipt-bound work.status result or read-only
   transcript evidence. Keep execution/input identity, the latest end_turn reply,
   and its time separate from the capture's window identity and timestamp.
   Never query the human daemon at 8399 or alter Desktop private stores.
3. Inspect the captured pixels for distinctive text from that exact completed
   turn. Only when the visible session and content match, write a comparison
   record with `renderState: ui-confirmed`, the exact input/turn identity, PNG and
   metadata paths, matched visible text and transcript evidence reference.
   A PNG existing, a title/link, CLI exit, receipt, terminal or OCR hit alone is
   not confirmation. Read/seen-by-human remains unconfirmed even if rendered.
4. If turn 1 is visible but turn 2 is only in the transcript, explicitly record
   `renderState: ui-unconfirmed`, naming both facts. Include missing permission,
   capture failure or insufficient visible evidence in the reason as applicable.
   Never feed a transcript success back as Desktop rendering success.

Keep the request, stdout/error, PNG/JSON when successful, comparison record and
transcript reference in evidence. Register evidence with artifact.file.register
when available and reference it with one sentence. No background process or test
daemon is started by this helper. Remove its worktree only after merge/close;
preserve evidence elsewhere. No automated GUI interaction is part of this journey.
