# Speech provider test operation

Run the metadata proof on an isolated test host:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-test-speech.ts
```

The helper starts an isolated daemon and a loopback speech service, saves a
synthetic voice key in the daemon's own store, and invokes `voice.testSpeech`
through Neo's MCP adapter. It verifies a PCM response succeeds and a 401 body
that echoes saved keys returns `[key]`. It also saves a key while the service
waits and checks that the save completes and the new key is redacted. It also
checks that a non-audio response is reported as a failure. It records
the results and request
count in `voice-test-speech.json`; retain that file, the proof log and exit code.
