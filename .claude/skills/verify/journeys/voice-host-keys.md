# Voice keys by host

Build the web bundle and launch an isolated daemon as described in the verify
skill. Generate a disposable self-signed TLS certificate inside the run directory:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$RUN/server-key.pem" \
  -out "$RUN/server-cert.pem" -days 1 -subj '/CN=localhost'
RUN="$RUN" VERIFY_PORT=9311 bun .claude/skills/verify/voice-host-keys.ts
```

The helper first verifies that provider creation rejects a voice credential id. It
then saves two synthetic credentials through the settings RPC, checks the
replies omit them, and sends recorded audio to two isolated TLS servers. It
asserts each server receives only its own host's key. It removes a key after its
host is no longer configured, then checks that host receives no key when restored.
It also refuses a blank key and confirms the saved credential remains usable.
Keep its result in the
run evidence, then stop the daemon before the legacy-key check below.

To cover a pre-upgrade inline key, stop the isolated daemon, seed only its
synthetic database as below, and relaunch the same run. Then run the helper with
`VERIFY_LEGACY=1`; it must report `legacyHostChangeRefused: true` and
`simultaneousClearRefused: true`.

```bash
sqlite3 "$RUN/data/daemon.db" "UPDATE global_settings SET settings = json_set(settings, '$.voice', json('{"enabled":true,"endpoint":"https://old.example/transcribe","model":"test","apiKey":"synthetic-legacy-key"}')) WHERE id = 1;"
VERIFY_LEGACY=1 RUN="$RUN" VERIFY_PORT=9311 bun .claude/skills/verify/voice-host-keys.ts
```

Seed only after stopping the daemon and before restarting it; never modify a
running daemon database or a real settings database.

After both checks, stop the daemon and clean up as directed by the verify skill.
