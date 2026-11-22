# Show the voice waveform after microphone audio is flowing

Follow the Verify skill for the pinned Bun, isolated daemon and Chromium setup.
Build the web app from the checkout under test.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-submit-matrix.ts capture-readiness
```

The helper pairs the real Neo web composer and runs both desktop click and
phone viewport touch cases in Chromium. It holds the real microphone source
disconnected from the audio graph after permission is granted. The waveform
and stop control must stay hidden and the mic position must show a cancellable
spinner. Cancel must preserve the draft and send no audio for transcription.

After a second start the helper connects the source to the graph, checks the
waveform delay, then stops into the draft. The synthetic ASR must receive the
startup audio, and the transcript must land in the existing draft with no
message sent. Check `capture-readiness.json`, the startup screenshots and an
exit code of 0. The unfixed composer fails by displaying the waveform before
the source is connected.
