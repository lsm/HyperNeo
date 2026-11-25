# Voice keys stay on their host

Use the isolated launch and doctor workflow in the verify skill. With the daemon
running, run:

```bash
VERIFY_PORT=19311 bun .claude/skills/verify/voice-keys-by-host.ts > "$RUN/evidence/voice-keys.json"
```

The helper owns an ephemeral loopback Deepgram-shaped live server and closes it
in finally. It saves a voice API key for an HTTPS batch endpoint on `localhost`,
sets the live URL to the stub on `127.0.0.1` with mode streaming, and records
one stream through the public stream RPC.

End state: the stream starts and stops `via: streaming` with the stub's final
text, and the stub saw exactly one connection with no `Authorization` header.
Before keys were looked up by host, the batch key was resolved for the live
stream, so a streaming start was refused because the key would have gone over
plain WS. Stop the owned daemon and remove its temporary data.
