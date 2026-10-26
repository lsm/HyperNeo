# Live transcription language

Follow shared setup, isolation and cleanup in SKILL.md. Build the web UI first.
With two free ports and a fresh absolute run directory, run:

```bash
NODE_PATH=/path/to/existing/node_modules bash .claude/skills/verify/voice-language.sh "$RUN" 9461 9462
```

The helper opens the built Voice Input settings in a headless browser with a
synthetic microphone. Auto is initially selected. It selects Auto, 中文, English,
then Auto again, reloads after each choice, and starts a recording through the
actual Neo microphone button. It captures the client stream-start request and
the local mock ASR socket request. Auto omits language; the other choices send
zh and en. Each setting survives reload and applies on the next connection.
Evidence is voice-language.json and settings screenshots in evidence/.
No real ASR, provider or human microphone is used. Browser storage makes the
preference specific to this browser. Existing endpoint query parameters remain
unchanged in Auto; explicit choices override an endpoint language parameter.

If browser startup is blocked as described in SKILL.md, retain its error and run
the same launcher with `VERIFY_RPC_ONLY=1`. That exercises four connections
(Auto, zh, en, Auto) through the public daemon RPC door and records the mock
ASR request plus the final transcript in voice-language-rpc.json. Run the
VoiceSettings.language.test.tsx component journey for selection, remount
persistence and client stream request coverage. This fallback leaves actual
browser reloads, screenshots and microphone interaction unverified.
