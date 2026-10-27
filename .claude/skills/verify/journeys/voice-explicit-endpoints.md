# Explicit batch and live voice URLs

Use the isolated launch and doctor workflow in the verify skill. Build the web UI
first. Run journey 2 with `voice.ts` to prove an explicitly configured live URL
still returns interim and final transcripts.

With that daemon still running, run:

```bash
VERIFY_PORT=19311 bun .claude/skills/verify/voice-explicit-endpoints.ts > "$RUN/evidence/batch.json"
```

The helper owns an ephemeral loopback HTTP ASR server and closes it in finally.
It uses only the isolated daemon supplied by VERIFY_PORT. It sets an empty live
URL with mode streaming, records audio through the public stream RPC, and observes
batch transcription. Its ASR receives the configured version path and query
verbatim, then a full transcription URL including a trailing slash and query.
A direct voice.transcribe request also succeeds with the full stored URL.

Open `/settings?tab=voice`. Save distinct Batch endpoint and Live endpoint URLs,
reload, and confirm both values. Clear Live endpoint, reload, and confirm it is
empty while Batch endpoint is preserved. Inspect desktop and mobile widths;
retain screenshots. The empty-field description must say batch only.

End state: batch.json records exactly three HTTP requests at the configured paths;
journey 2 records live transcripts; the settings page exposes two independent
persisted fields. Save evidence outside the synthetic daemon directory, stop the
owned daemon and mock, and remove their temporary data.
