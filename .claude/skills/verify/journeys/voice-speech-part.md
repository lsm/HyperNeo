# Spoken replies follow the speech part of voice settings

Use the isolated launch and doctor workflow in the verify skill. The launch
starts from a clean environment, so `HYPERNEO_SPEECH_URL` is unset. With the
daemon running, run:

```bash
VERIFY_PORT=19311 bun .claude/skills/verify/voice-speech-part.ts > "$RUN/evidence/voice-speech-part.json"
```

The helper owns an ephemeral loopback OpenAI-shaped speech server and closes it
in finally. It saves a speech part pointing at that server through the public
settings RPC and reads the voice list through the `neo.speech.catalog`
operation door.

End state: the voice list is the server's own while it answers, OpenAI's
published voices (including `alloy`) once it returns 404, and the catalog
refuses with `speech_backend_not_configured` after the speech part is cleared.
The server saw exactly two `GET /v1/audio/voices` requests. Synthesis with the
part's key is covered by the focused speech suite. Stop the owned daemon and
remove its temporary data.
