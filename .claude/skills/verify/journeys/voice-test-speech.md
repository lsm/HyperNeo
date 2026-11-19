# Speech provider test operation

Run the metadata proof on an isolated test host:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-test-speech.ts
```

The helper starts an isolated daemon and a loopback speech service, saves a
synthetic voice key in the daemon's own store, and invokes `voice.testSpeech`
through Neo's MCP adapter. It verifies a PCM response succeeds and a 401 body
that echoes the saved key returns `[key]`. It records the two results and request
count in `voice-test-speech.json`; retain that file, the proof log and exit code.
