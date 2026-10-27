2. **Voice streaming relays text.** Start the stub ASR (Deepgram protocol) with
   `bun .claude/skills/verify/asr-stub.ts 9312 < /dev/null > "$RUN/asr-stub.log" 2>&1 & echo $! > "$RUN/asr-stub.pid"`, then
   `VERIFY_PORT=9311 bun .claude/skills/verify/voice.ts 9312`. It points voice at
   the stub through the one service link (`http://…/speech/v1`, no explicit
   stream endpoint; the daemon derives the batch and live listen URLs), starts
   a stream, sends three chunks and stops. End state: `started.via` and
   `stopped.via` are `streaming`, `stopped.text` is the final text, and `texts`
   holds the interim `voice.stream.text` events and one `isFinal`.
