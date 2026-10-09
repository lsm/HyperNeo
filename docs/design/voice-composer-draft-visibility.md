# Voice composer: what happens to the draft behind the mic

Status: proposal for decision. Nothing here is implemented.
Scope: the Neo composer on web (`NeoComposer` + `NeoVoice`), the chat composer on web (`MessageInput` + `InputTextarea`), and the Neo iOS composer (`ComposerDock`).
Supersedes, if accepted: the blanket hide in lsm/HyperNeo#6156 and lsm/neo-ios#21.

## The problem

The complaint was that draft text leaked through or around the voice waveform and looked confusing. The blanket fix hides the draft for the whole voice session. That removes the leak, but it also removes the reason people keep a draft visible while dictating: you paste or type something, then keep talking, and the words land after it. With the draft hidden you are dictating blind onto text you can't see.

The leak comes from the layout, not from the draft being visible. On two of the three surfaces the waveform is laid on top of the text box instead of next to it.

| Surface | Today on `dev` | Why it leaks or jumps |
|---|---|---|
| Web Neo composer | `NeoVoice.tsx:165` puts the bar at `absolute inset-x-4 top-4` over the form. The textarea stays mounted, `rows={2}` (`NeoComposer.tsx:194`), disabled while voice is busy (`:172`). | The bar is about 36px tall; two rows of `leading-relaxed` text are about 52px. Line 2 of the draft shows under the bar, line 1 is covered. That is the leak. |
| Web chat composer | `InputTextarea.tsx:219` swaps the textarea for `recordingBody` and pins the height to 40px (`:116`). | No leak: the draft is already fully hidden. A multi-line draft collapses to one row, then springs back on stop. The transcript is inserted at the saved cursor or replaces the saved selection, and you can't see either. |
| iOS Neo composer | `ComposerView.swift:25-40`: a `ZStack(alignment: .top)` with the 48pt `VoiceWaveform` over `ComposerTextView` (2 to 8 lines). The text view is editable while recording; only `transcribing` disables it. | Lines past the first two show below the bar, and the visible lower lines are still tappable and editable under a recording. |

The open PRs (#6156 web, neo-ios#21) make the draft invisible on the Neo surfaces and pin the chat composer's existing hide with a test.

## Recommendation: one rule

The voice bar never shares pixels with the draft. The draft stays visible, read-only and slightly muted while voice is active, and it is scrolled so you can see where the transcript will land.

Where the bar goes depends on the composer's shape:

- Neo web and iOS have a separate control row under the text (attach, model, mic, send). The bar replaces the left side of that row (attach + model/preferences). Stop and the send arrow stay on the right. The text box doesn't move or change height.
- The chat composer is a single pill with the controls inline. The bar gets its own row inside the pill, under the draft. With an empty draft only the bar row shows, which is how it looks today.

That one rule covers nearly every case below. Three cases need their own treatment: an empty draft (no draft row needed), a selection in the chat composer (the transcript will replace it, so show what will be replaced), and send intent with attachments on web Neo (today that's a failure, not a layout question).

Treatment vocabulary used in the tables:

- visible: full contrast, as when idle.
- muted: readable but de-emphasized (`text-fg-muted`, or `Neo.fgMuted` on iOS), read-only, no placeholder. Not faded to unreadable; you still need to read it.
- moved: the draft and bar swap or stack differently from idle.
- hidden: not shown.

## Sketches

Legend: `[x]` cancel, `|||||` live bars, `0:42` time left, `[■]` stop (to draft), `[↑]` stop and send, `▍` where the transcript lands, `░░░` transcribing shimmer.

### A. Empty draft, recording

Neo web and iOS (bar in the control row; text area shows a one-line hint instead of the typing placeholder):

```
╭──────────────────────────────────────────────╮
│ Listening — your words appear here ▍          │  muted hint, not the typing placeholder
│                                              │
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│  bar takes the left of the control row
╰──────────────────────────────────────────────╯
  Recording · Tap the arrow to stop and send
```

Chat composer (unchanged from today):

```
╭──────────────────────────────────────────────╮
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│
╰──────────────────────────────────────────────╯
```

### B. One-line draft, recording

Neo web and iOS:

```
╭──────────────────────────────────────────────╮
│ Here is the stack trace from prod: ▍          │  muted, read-only, caret marks the append point
│                                              │
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│
╰──────────────────────────────────────────────╯
  Recording · Tap the arrow to stop and send
```

Chat composer (the pill grows by one row; the draft sits above the bar):

```
╭──────────────────────────────────────────────╮
│ Here is the stack trace from prod: ▍          │  muted, read-only
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│
╰──────────────────────────────────────────────╯
```

### C. Multi-line draft, recording

The draft keeps its idle height up to a cap of 3 visible lines and is scrolled to the insertion point. Neo and iOS append at the end, so that's the tail. The chat composer inserts at the saved cursor, so it scrolls to the cursor.

```
╭──────────────────────────────────────────────╮
│ ⋮ (scrolled; earlier lines above)             │
│ at Worker.run (worker.ts:88)                 │  muted, read-only, scrollable
│ at async main (index.ts:12) ▍                 │
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│
╰──────────────────────────────────────────────╯
```

### D. Transcribing after the arrow (send intent)

The draft and the incoming transcript go out together as `draft + "\n" + transcript`. Show both until the send is accepted, then clear as a normal send does.

```
╭──────────────────────────────────────────────╮
│ Here is the stack trace from prod:            │  muted
│ ░░░░░░░░░░░░░░░░                              │  shimmer where the transcript will go
│ [x̶] ··········· Transcribing…        [■̶] [↑̶]│  bars at 45%, buttons disabled
╰──────────────────────────────────────────────╯
  Sending with your draft…
```

### E. Transcribing after Stop (draft intent)

Same frame as D, with a different status line. When the text arrives it appears at the shimmer, the whole draft returns to full contrast, and the caret sits after the inserted text.

```
╭──────────────────────────────────────────────╮
│ Here is the stack trace from prod:            │  muted
│ ░░░░░░░░░░░░░░░░                              │
│ [x̶] ··········· Transcribing…        [■̶] [↑̶]│
╰──────────────────────────────────────────────╯
  Transcribing into your draft…
```

Afterwards:

```
╭──────────────────────────────────────────────╮
│ Here is the stack trace from prod:            │  visible, editable
│ it only fails on the second retry▍            │
│ [+] (model ▾)                         [🎙] [↑]│
╰──────────────────────────────────────────────╯
```

### F. Chat composer with a selection when recording started

The transcript replaces the selection (`MessageInput.tsx` builds `before + transcript + after` from the saved selection). If you can't see the selection, that's a surprise, so keep it highlighted and struck through:

```
╭──────────────────────────────────────────────╮
│ Deploy to ~~staging~~▍ tonight                │  selected span highlighted and struck through
│ [x] ||||||||||||||||||||||||||| 4:18  [■] [↑]│
╰──────────────────────────────────────────────╯
```

## Case tables

Unless a row says otherwise, it applies to all three surfaces. "Neo" means Neo web and iOS, which behave the same.

### Starting (mic permission or warm-up: "Waiting for mic…")

| Draft | Attachments | User sees | Treatment | Reason |
|---|---|---|---|---|
| Empty | any | Final recording layout with "Waiting for mic…" in place of the timer | hint only | Show the recording layout straight away so the layout only changes once. |
| One line | any | Draft muted above the bar; chips unchanged | muted | Same frame as recording; no second jump when the mic opens. |
| Multi-line | any | Draft capped at 3 lines, scrolled to the insertion point | muted | Same as recording. |

### Recording

| Draft | Attachments | User sees | Treatment | Reason |
|---|---|---|---|---|
| Empty | none | Sketch A. Neo: hint "Listening — your words appear here". Chat: bar only. | hidden (nothing to show) | No draft row to protect; the hint says where the text will go. |
| Empty | present | Sketch A, with the chips still above, full contrast | chips visible | Chips are part of what you're about to send; the bar never covers them. |
| One line | none | Sketch B; caret at the append or insert point | muted, moved (chat only) | Keeps the "dictate onto what I pasted" context; muting makes the bar the focus. |
| One line | present | Sketch B plus chips | muted; chips visible | Same as above. |
| Multi-line | none | Sketch C; 3-line cap, scrollable, scrolled to the insertion point | muted, capped | The caret is what matters while dictating; the cap stops a long draft pushing the bar away. |
| Multi-line | present | Sketch C plus chips | muted, capped; chips visible | Same as above. |
| Any, with selection (chat only) | any | Sketch F | muted; selection highlighted | The transcript will replace that span, so say so. |

Tapping the muted draft while recording does nothing on the text itself; scrolling still works. Editing during recording is out (decision 2).

### Transcribing, by intent

| Intent | Draft | Attachments | User sees | Treatment | Reason |
|---|---|---|---|---|---|
| Arrow (send / steer / queue) | Empty | none | Bar dimmed, "Transcribing…"; then the message appears in the thread | hint hidden | Nothing to preserve. |
| Arrow | Non-empty | none | Sketch D: draft muted plus shimmer line; "Sending with your draft…" | muted | The draft is part of the outgoing message; hiding it hides what you're sending. |
| Arrow | any | present, iOS | Falls back to the draft; sketch E, then the existing "Added to your draft so it goes out with your attachments" note | muted, then visible | Already how `stopRecordingAndSend` behaves; keep it. |
| Arrow | any | present, Neo web | Today: `sendVoice` returns `unconfirmed` (`NeoComposer.tsx:114`), so you get "Could not send that recording…" and a resend tray entry. Proposed: copy iOS (fall back to draft and say why), or send the attachments with it. | muted, then visible | Not a visibility problem, but it's the same case, so it should be fixed with it (decision 4). |
| Arrow | any | present, chat | Images go out with the voice send (`captureVoicePayload`); show sketch D with chips | muted; chips visible | Chips are being sent; keep them in view until accepted. |
| Stop (to draft) | Empty | any | Shimmer in the text area, then the transcript, editable | visible after | You asked to review before sending. |
| Stop | Non-empty | any | Sketch E, then the full draft with the transcript appended (Neo, iOS) or inserted at the cursor (chat) | muted, then visible | The point of seeing the draft: you watch the new text land after the pasted text. |
| Duration limit or interruption (iOS audio interruption, web 5-minute cap) | any | any | Same as Stop: transcribed into the draft | as Stop | Both already route to draft intent. |
| Cancel `[x]` | any | any | Bar disappears; draft back to full contrast, unchanged; caret where it was | visible | Nothing changed, so nothing should move. |

### Failure and retry

| Situation | User sees | Treatment | Reason |
|---|---|---|---|
| Silent recording or transcription error | Bar disappears, draft back to visible and unchanged, error toast or line, resend tray entry | visible | The draft was never touched; show it as it is. |
| Resend from the tray (web) | Bar shows "Transcribing…" again; the draft stays muted as in D or E, depending on the saved intent | muted | Same frame as a live transcription. |

## Append or replace when dictating over pasted text

Recommended: append, never replace, unless you explicitly selected text first.

- Neo web and iOS already append with a newline (`NeoLive.tsx:684`, `DraftBook.applyVoice`). The send arrow composes `draft.trim() + "\n" + transcript`. Keep both.
- The chat composer inserts at the cursor saved when recording started and replaces a selection if there was one. That's the power-user behaviour macOS dictation has too. Keep it, but only with sketch F so it's visible. If you'd rather never replace, collapse the selection to its end when recording starts (decision 3).

## Platform notes

### iOS

- Make `ComposerTextView` read-only for the whole voice session (`disabled: store.recorder.isRecording || store.transcribing`), not just while transcribing. Today the lower lines can be edited under a live recording.
- Dismiss the keyboard when recording starts (`focused = false`). Dictating with the keyboard up hides half the thread and gives nothing back. Don't re-focus after Stop; let the user tap in, so the keyboard doesn't pop over the transcript they want to read.
- With the bar in the control row the dock height doesn't change, so there's no keyboard or safe-area relayout. The 3-line cap applies only to the text view's `maxLines` while voice is active (8 → 3), with scroll pinned to the end.
- VoiceOver: don't mark the draft `accessibilityHidden` (neo-ios#21 does). Read it as "Draft, read-only while recording". The bar keeps its own labels.
- The status line (`composerStatus`) already exists; add the two transcribing variants ("Sending with your draft…" and "Transcribing into your draft…").

### Web, mobile (coarse pointer)

- Disabling a focused textarea blurs it and closes the soft keyboard. Good: keep that for recording.
- Don't re-open the keyboard after voice ends. `InputTextarea.tsx:120` focuses on every `recordingBody → undefined` change, and `insertTranscript` focuses again (`MessageInput.tsx:433`). On a coarse pointer that pops the keyboard right after Stop, covering the result. Restore the caret position without focusing on touch devices; keep focusing on desktop.
- Neo web's textarea is fixed at `rows={2}` and scrolls instead of growing, so "multi-line" there means "scrolled". Pin scroll to the bottom while voice is active.

### Web, desktop

- Re-focus after Stop and Cancel, with the caret after the inserted text (Stop) or where it was (Cancel). That's today's chat composer behaviour, extended to Neo.
- The muted draft can be selected and copied but not edited.

## Where one rule is enough, and where it isn't

Covered by the one rule (draft muted and read-only, bar never over the text):

- every recording and starting case on all three surfaces
- transcribing for both intents
- attachments (chips are never under the bar)
- cancel and failures (draft returns unchanged)

Needs its own treatment:

1. Empty draft: there's nothing to show, so show a hint on Neo and only the bar in chat.
2. Chat composer selection: highlight what will be replaced (sketch F).
3. Send intent with attachments on Neo web: behaviour fix, not layout (decision 4).
4. The chat composer's bar placement differs (its own row inside the pill, not the control row) because that composer has no separate control row.

## Decisions for you

1. Bar placement on Neo web and iOS: in the control row (recommended: no height change, no overlap), or as an extra row above the controls (simpler, but the composer grows by about 40px).
2. Editing while recording: read-only (recommended: stable insertion point and no keyboard on mobile), or editable on desktop only.
3. Chat composer selection: replace the selection with sketch F (recommended), or always collapse to the cursor.
4. Neo web, arrow while attachments are present: fall back to the draft like iOS (recommended, smallest change), or send the transcript with the attachments.
5. Multi-line cap while voice is active: 3 lines (recommended), or keep the idle height (up to 8 lines on iOS, about 200px on chat).

## What to do with the open PRs

- lsm/HyperNeo#6156: close it. Its Neo change (`invisible` on the textarea) is the blunt hide this replaces. Its new chat-composer test pins the hide that this design removes.
- lsm/neo-ios#21: close it. The opaque background is the right instinct for the overlap, but the control-row placement removes the overlap without hiding the text.

## Implementation slices (after a decision; not part of this PR)

1. Web Neo: move `VoiceWaveform` out of the absolute overlay into the control row; draft muted and read-only; hint for an empty draft; status-line variants.
2. Web chat: keep the textarea mounted (muted, read-only, 3-line cap) above the existing recording row instead of swapping it out; selection highlight; no auto-focus on coarse pointers.
3. Web Neo: arrow with attachments, per decision 4.
4. iOS: waveform into the control row, text view read-only for the whole voice session, keyboard dismissed on start, `maxLines` 3 while active, status variants; drop `accessibilityHidden`.
