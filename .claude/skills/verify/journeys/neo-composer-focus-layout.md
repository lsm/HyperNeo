# Neo composer focus and action ownership

Follow SKILL.md isolation, pinned runtime and resource preflight on a designated
test host. Build the web from the source tree being verified. Use the guarded,
paired composer-frame.sh journey in composer-frame.md for the idle capsule,
expanded draft, control geometry, attachment row and recording appearance.

The empty idle capsule stays about 48px high, centered at 83% of the column.
Focusing expands it; clearing and blurring restores it. The inert realtime-voice
entry remains visible. Recording uses its full-width row with flat controls.

For the actual Neo session pane, run:

```bash
bash .claude/skills/verify/proof-run.sh <fresh-absolute-evidence-directory> \
  .claude/skills/verify/composer-attention.ts <chromium-executable> <playwright-package> after
```

The helper owns its daemon, synthetic HOME/DB and guarded frontend. It pairs a
synthetic browser, then opens the worker through the question-card session link.
Both themes at 390px/1280px must show only Stop when a turn runs with an empty
focused draft. Typing switches that position to Send. Stop reaches the synthetic
interrupt RPC peer. A later question leaves an empty unfocused composer collapsed;
errors still expand it and show the status. No SDK interruption is claimed.

A baseline snapshot can use the final argument `before`: it captures the previous
two-button focused row and question-expanded layout. Run that against the actual
baseline source/build in the test host snapshot, then restore the current source
and rebuild. Retain attention.json, sixteen screenshots and cleanup.json per run.

For recording behavior, use:

```bash
VERIFY_BROWSER=<chromium> VERIFY_PLAYWRIGHT=<playwright-package> \
VERIFY_MOCK_PORT=19347 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/composer-behavior.sh 19346
```

This uses fake microphone media and a delayed, numbered ASR fixture. Eight cases
cover streaming/batch, phone/desktop and Stop/Send cancellation. Cancel restores
the original draft without a saved recording or sent message. A second recording
starts before the cancelled response arrives and must retain its own capture.
Batch cancellation must close the provider upload before the UI returns to idle.
The next recording submits immediately without waiting for the old provider
response and completes with its own unique text. Run the same command with
`19346 --cancel-only` after composer-behavior.sh to verify only cancellation.
The fixture status reader only reports synthetic utterance counters.

To cover cancellation after a streaming connection fails, pass `19346 --fallback-only`
to composer-behavior.sh instead. The ASR fixture disconnects after its first interim
text. Four phone/desktop and Stop/Send cases then enter the real HTTP fallback
inside `voice.stream.stop`. Cancellation must close that provider connection
before another recording is accepted. The next recording must immediately
complete with its own text, without an admission error or stale result.

A final real-time case records for four minutes. The timer starts at zero and
advances through three minutes while capture remains active; the recorder then
automatically stops around 240 seconds and returns the text to the draft. The
long waits are the feature boundary itself, not increased production timeouts.
Retain behavior.json, progress logs and screenshots, and inspect them for clipping.
A browser or transport refusal is not a pass; preserve its failure evidence.
