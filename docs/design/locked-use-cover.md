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

On macOS 26.6.2, this Mac's aerial entry returns `/System/Library/CoreServices/DefaultDesktop.heic`, a root-owned final-component symlink whose link text is `/System/Library/Wallpapers/.default/DefaultAerial.heic`. The target is root-owned, regular and ImageIO-decodable on the sealed system volume. The cover therefore shows Apple's default aerial still, which may differ from the aerial selected in Settings. No public API maps that selection to its own still or current frame; do not scrape private wallpaper stores to try.

The cover deliberately handles wallpaper kinds through one decode-or-fall-back rule:

| Wallpaper | Cover behavior |
| --- | --- |
| Static image | Use the decoded image only after the lexical path and link checks below. |
| Dynamic image | Draw the still that ImageIO decodes. Do not add animation or promise time-of-day synchronization. |
| Video or aerial wallpaper | Use a still only if the returned URL passes those checks and decodes as an image. The public API has no video playback or current-frame contract; otherwise use the fallback. |
| Solid color, missing URL, unreadable file or decode failure | Use the existing dark blue, now at alpha 1.0. |
| Per-Space wallpaper | Query each active `NSScreen`. The API has no Space selector, so do not enumerate Spaces, switch Spaces or claim to reproduce a background Space's wallpaper. |
| Separate lock-screen wallpaper | There is no supported lock-screen image selector in this API. Use the current user's returned desktop image when it passes the checks, otherwise the fallback; do not read private login-window state. |

The fallback is per display. One bad or missing wallpaper must not prevent another display from using its valid image, and must never weaken the full-frame cover checks.

### Bounded, system-only wallpaper load

Put the opaque blue cover on every display and verify its full frame first. Only then query each screen's URL on the main thread and hand candidate URLs to a background worker. Cover placement, `covered`, owner input and relock never wait for file I/O or decoding.

Inspect each returned file URL's path as text before any filesystem call: require an absolute path with no `.` or `..` components under `/System/Library/` or `/Library/Desktop Pictures/`. Anything else falls back to blue with no filesystem call on it whatsoever.

On the worker, open the returned path with `O_RDONLY | O_NOFOLLOW_ANY`. If that fails with `ELOOP` and the path is under `/System/Library/`, handle only a final-component symlink: open the parent with `openat(AT_FDCWD, parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)`, then call `readlinkat` once for the final component without following it. Join a relative link target to the parent as text, normalize separators without touching the filesystem, reject any `.` or `..` component, and require the target strictly under `/System/Library/`. Open that target with `O_RDONLY | O_NOFOLLOW_ANY`. A second symlink, an intermediate symlink, or any other error means blue; an `ELOOP` under `/Library/Desktop Pictures/` also means blue. Do not call `realpath` or any URL link-following helper.

Validate the successful descriptor with `fstat`: regular file, owned by root, at most 64 MiB. Read and decode from that descriptor, never by reopening its path; a failed validation leaves blue in place without a prompt.

Read the bounded descriptor data into ImageIO off the main thread, with output capped to the display's pixel size and a two-second result deadline. Late results are discarded, as are results for a replaced display generation or an ending guardian. Swap a finished image into its existing opaque cover on the main thread. Never log or include the URL, path, metadata, image contents or decode error details in an artifact.

The shipped guardian's separate hardened-runtime signature has no entitlements (`locked-use/build.sh:11–12`). Whether TCC attributes access to it or to the responsible HyperNeo app, that identity grants no protected-file access and does not relax the allowlist. Never request a broader grant, retry a denied read or open a file picker.

## Implementation boundary

In `packages/desktop/locked-use/guardian.m`:

- Change `cover` at lines 163–208 to install an opaque blue, full-frame window first, then start the bounded wallpaper load above. A finished image draws aspect-fill inside that window; the blue remains underneath it.
- Preserve the existing screen-relative frames, shielding level, all-Spaces behavior, event transparency, sharing exclusion, ordered replacement and `cover_mismatch` failure path at lines 164–207.
- Build the centered stack at lines 184–200 from the parent HyperNeo application's `NSRunningApplication.icon`, the status line and the unchanged hint. Using the already-trusted parent app's icon avoids adding another packaged asset. Remove the now-unused `started` property at line 157, assignment at line 366 and fixture assignment in `check-cover.m:142`.
- Extend `end:` at lines 302–327 with a new 750 ms hold: once the lock flag becomes set, every cover stays fully opaque until it has remained continuously set for 750 ms. An unlocked read resets that hold. No public API proves that the lock screen has drawn on each display; the hold is a mitigation, not proof.
- After that hold, start the 0.3-second fade only while `screenLocked()` is true and the animation can finish before the 10-second deadline. Keep checking lock state throughout it. If the session becomes unlocked mid-fade, cancel the animation, restore every cover to alpha 1 at once, request an immediate relock and return to the existing wait loop. Clear the hold timestamp so the next fade attempt requires another 750 ms of continuous lock; do not exit on this transition.
- If a fade cannot finish before the deadline, skip it and stay opaque until the deadline. At the deadline, cancel any partial animation and ensure every cover is opaque before the existing outcome: locked reports `ended` and exits 0; unlocked reports `ended … relock_failed` and exits 3. Process exit removes the covers in either case exactly as today, with Desktop's unclean-exit relock as the backstop only for the failure outcome. This design adds no new exit-code path and neither adds nor fixes the deadline-exposure case.
- Do not fade while an Allow or relock is pending. The existing 10-second guardian exit deadline, measured from entry to `end:`, includes every hold and fade attempt; neither extends it.

No new timer or lifecycle rule is added beyond the fade's lock-state checks. Owner input still triggers the same stop-and-relock path. The fade is worth keeping for the smoother handoff the owner requested, but it is presentation only and never counts as evidence that locking succeeded.

## Privacy and verification

Do not use `CGDisplayCreateImage`, `CGWindowListCreateImage`, ScreenCaptureKit or any other screen capture. Capturing the desktop or lock screen would require a new privacy grant and could put another person's windows into an artifact. Do not scrape private wallpaper preferences either. The lexical path and final-link checks avoid protected and remote reads instead of relying on TCC to stop them; an unexpected access or decode failure simply retains blue. No Screen Recording permission, new grant or setting is needed.

The implementation should extend the headless cover and release fixtures with the default-aerial final link, direct system paths, library paths, relative and dot-component paths, paths outside the allowlist, intermediate and second-link escapes, non-regular or non-root-owned files, oversize files, slow and late decodes, and proof that neither initial coverage nor relock waits. Assert that rejected paths receive no filesystem call at all, accepted files are validated and decoded through the descriptor actually opened, fallback stays opaque, and logs contain neither wallpaper paths nor contents. Pin the 750 ms opaque hold, a fade that starts only while locked with enough deadline remaining, and an unlock during the fade restoring alpha 1, requesting relock and restarting the hold without exiting. At the deadline, assert opaque covers followed by exit 0 when locked and `relock_failed` with exit 3 when unlocked.

The attended signed-build check should use two displays with different built-in wallpapers, confirm full opaque coverage and centered branding on each, and then stop with owner input: the cover stays opaque through relock and the 750 ms hold before wallpaper, icon and both text lines fade together. With Apple aerials, confirm the returned default still appears and the check records that it may not match the selected aerial. Video playback and lock-screen-specific wallpaper matching are not acceptance criteria.
