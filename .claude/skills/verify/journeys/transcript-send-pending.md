# Send tapped while the final transcript is pending

Use the verify skill's isolated daemon and built web UI. Start the synthetic ASR
with `bun .claude/skills/verify/transcript-send-asr.ts <free-port>` in the owning
shell and retain its PID for cleanup. Its POST waits until `/release` is called;
`/stats` reports received requests and whether the final text is held.

Configure voice through the isolated RPC with a full loopback batch URL, model
`stub`, allowPrivateNetwork true, and an empty streamEndpoint. In a browser with
synthetic microphone input, open `/neo`, type a prefix, start recording, then
press Stop to transcribe into a draft. Wait until ASR stats says held. Tap the
enabled Send button twice. Before releasing ASR, inspect the browser's recording
in IndexedDB: intent is send, sendDraft is the prefix, and sendContext records
staged photos, file text, quote and Preview when present. No message has sent yet.

Call `/release`. End state: exactly one `neo.message.send` operation carries the
recording UUID as requestId, prefix plus final transcript, and the accepted
context. The message is visible in the chat and that audio record is removed.
Repeat at mobile width. Existing recording-arrow staging remains: while still
recording, an attachment, reply or Preview sends the transcript into the draft;
only a subsequent pending-transcription Send tap upgrades that intent.

The component regressions also hold ASR, change later text/quote, and confirm
the captured message sends while newer edits survive. ASR failure produces no
partial send. Recovery contracts use the stored context after the interactive
submit exits. Retain browser screenshots, operation payloads, doctor output and
test logs outside temporary daemon data. Close the browser, stop the owned ASR,
daemon and mock, then remove only their synthetic data.
