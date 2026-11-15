# A mic track ending mid-recording keeps the words as a draft

Follow SKILL.md for the pinned Bun, resource check, fresh synthetic HOME/data/DB
and headless Chromium setup. Build the current web checkout first.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-submit-matrix.ts track-ended
```

The helper reuses the voice-submit fixture: an isolated daemon, a local ASR that
holds its transcript until released, and Chromium capturing a synthetic WAV
through real getUserMedia/AudioWorklet. The browser types a prefix in the Neo
composer, starts dictation, then fires `ended` on the captured tracks, which is
what the browser does when another app takes the mic or the input device goes
away. A real device cannot be unplugged from a headless run, so the event is
dispatched on the real track objects.

The recording must finish on its own: the ASR receives the captured audio, and
after release the transcript lands in the draft beside the typed prefix with no
message sent. Before the fix the composer keeps showing a live recording and the
ASR never receives a request, so the run fails at "The ended track must finish
the clip". track-ended.json records the track count, ASR stats, draft and send
count; screenshots keep the moment after the event and the final draft. Require
the wrapper's exitCode 0.
