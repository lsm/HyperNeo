# Voice keys by host

Build the web bundle and launch an isolated daemon as described in the verify
skill. Generate a disposable self-signed TLS certificate inside the run directory:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$RUN/server-key.pem" \
  -out "$RUN/server-cert.pem" -days 1 -subj '/CN=localhost'
RUN="$RUN" VERIFY_PORT=9311 bun .claude/skills/verify/voice-host-keys.ts
```

The helper saves two synthetic credentials through the settings RPC, checks the
replies omit them, and sends recorded audio to two isolated TLS servers. It
asserts each server receives only its own host's key. Keep its result in the
run evidence, then stop the daemon and clean up as directed by the verify skill.
