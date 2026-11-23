# Locked Use wallpaper cover

Replace the flat blue Locked Use cover with the wallpaper already familiar to the owner. Every display stays fully covered while HyperNeo works, with a small centered identity instead of a panel. This is a visual change only: locking, owner-input handling, authorization and Desktop ownership stay unchanged.

## Appearance

Each display gets its own full-screen composition:

- The display's decodable desktop image, aspect-filled and cropped as needed. The image and window are fully opaque; no desktop icon, window or lock-screen control shows through.
- The HyperNeo app icon above the single line **HyperNeo is using this Mac**, centered horizontally and vertically as one unit.
- The existing hint below it: **To stop, touch the keyboard, mouse or trackpad. The Mac locks again right away.**
- White text with a soft dark shadow for separation. No card, tint, blur, border or other background behind the icon or text.
- No **Working since** line. The same layout repeats independently on every display rather than being stretched across displays.

Use a 72 pt icon, a 32 pt semibold status line and a 16 pt hint as the starting sizes. Keep the hint on one line where it fits and wrap it within a readable maximum width on smaller displays. The wallpaper remains unobscured apart from the text shadows.

## What macOS 26 provides

[`NSWorkspace.desktopImageURL(for:)`](https://developer.apple.com/documentation/appkit/nsworkspace/desktopimageurl(for:)) takes an `NSScreen` and returns an optional desktop-image URL. Apple requires the call on the app's main thread. [`desktopImageOptions(for:)`](https://developer.apple.com/documentation/appkit/nsworkspace/desktopimageoptions(for:)) likewise exposes scaling, clipping and fill-color options, but no additional image source.

A read-only probe on macOS 26.6.2 returned a per-screen HEIC URL, and `NSImage` decoded it as a 3840 × 2160 still. That verifies the basic read-and-decode path, not a lock-screen or video-frame API.

The cover deliberately handles wallpaper kinds through one decode-or-fall-back rule:

| Wallpaper | Cover behavior |
| --- | --- |
| Static image | Read the URL for that `NSScreen` and draw the decoded image. |
| Dynamic image | Draw the still that `NSImage` decodes. Do not add animation or promise time-of-day synchronization. |
| Video or aerial wallpaper | Use a still only if the returned URL decodes as an image. The public API has no video playback or current-frame contract; otherwise use the fallback. |
| Solid color, missing URL, unreadable file or decode failure | Use the existing dark blue, now at alpha 1.0. |
| Per-Space wallpaper | Query each active `NSScreen`. The API has no Space selector, so do not enumerate Spaces, switch Spaces or claim to reproduce a background Space's wallpaper. |
| Separate lock-screen wallpaper | There is no supported lock-screen image selector in this API. Use the current user's returned desktop image when available, otherwise the fallback; do not read private login-window state. |

The fallback is per display. One bad or missing wallpaper must not prevent another display from using its valid image, and must never weaken the full-frame cover checks.

## Implementation boundary

In `packages/desktop/locked-use/guardian.m`:

- Replace the color and label construction in `cover` at lines 163–208. Resolve the wallpaper separately for each `NSScreen`, draw it aspect-fill, set `window.opaque = YES`, and keep an opaque blue `backgroundColor` underneath it.
- Preserve the existing screen-relative frames, shielding level, all-Spaces behavior, event transparency, sharing exclusion, ordered replacement and `cover_mismatch` failure path at lines 164–207.
- Build the centered stack at lines 184–200 from the parent HyperNeo application's `NSRunningApplication.icon`, the status line and the unchanged hint. Using the already-trusted parent app's icon avoids adding another packaged asset. Remove the now-unused `started` property at line 157 and assignment at line 366.
- Keep the lock confirmation in `end:` at lines 302–327 unchanged through the `locked` check. On the successful locked branch, fade every cover window's `alphaValue` from 1 to 0 over 0.3 seconds in one animation group, then report `ended` and exit. Because the artwork and labels share the window, they fade together.
- Do not fade while an Allow or relock is pending. On the existing timeout, preserve the `relock_failed` exit and do not run the success animation.

No timer or lifecycle rule is added. In particular, owner input still triggers the same stop-and-relock path; the cover simply remains visible until that path confirms the Mac is locked, then gently reveals the real lock screen.

## Privacy and verification

Do not use `CGDisplayCreateImage`, `CGWindowListCreateImage`, ScreenCaptureKit or any other screen capture. Capturing the desktop or lock screen would require a new privacy grant and could put another person's windows into an artifact. Do not scrape private wallpaper preferences either. Reading the public per-screen URL and decoding that file needs no Screen Recording permission and adds no permission prompt or setting.

The implementation should extend the existing headless cover and release fixtures with per-screen image URLs, one decode failure, opaque fallback, and proof that no fade begins before lock confirmation. The attended signed-build check should use two displays with different wallpapers, confirm full opaque coverage and centered branding on each, and then stop with owner input: the cover stays through relock and wallpaper, icon and both text lines fade together only after the lock screen is real. Repeat with an unreadable wallpaper to confirm the blue fallback. Video playback and lock-screen-specific wallpaper matching are not acceptance criteria.
