# Neo speaks independently of screen publications

Use shared resource/isolation setup in SKILL.md and run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/spoken-replies.ts verify
```

This boots the production daemon with an empty temporary HOME/database, no
provider credentials and external HTTP refused. Two real WebSocket clients call
the operation door; Neo speaks through the real MCP adapter. Require delivery to
only the opted-in client, stable-request retry deduplication, foreign-client ack
refusal, separately saved playing/played states, cancellation on disconnect,
no reconnect replay and zero extra publications. All writes use the real writer
worker. Inspect spoken-replies.json and the wrapper's exit status.

The replay also fills the queue and retries an existing request without replay,
and disconnects with pending speech, which must finish as cancelled. The
focused speech suite additionally checks independent session opt-out and delays
the real audit write to reproduce an acknowledgment racing a client disconnect.

`serve` mode is the companion native Simulator fixture: ports18554/18555, public
synthetic PCM, no model or microphone. The iOS spoken-replies journey owns it and
drives actual drawer controls and playback; protocol proof alone does not prove
the phone speaker, rendered UI, a real model's wording or native audio routes.

Speech and playback events reuse the existing accepted-operation SQLite audit.
Deduplication covers the last1024 utterances of the current daemon process,
including client reconnects; it is not a crash-recovery/outbox protocol. Startup
never replays stored audit history, and no audio or new schema is stored.

For server-pushed PCM, reserve18555 for the helper's synthetic TTS server.
`verify` also opts into audio on the second client and requires40 ordered PCM
chunks, the first before `end`, then a persisted played receipt. The production
daemon configures HYPERNEO_SPEECH_URL; the phone sends only a voice id. Catalog
and preview go through the operation door. Synthesis runs outside the admission
serial queue, with one upstream request at a time; terminal acknowledgments and
disconnect abort it. No audio or credentials are persisted. Phone playback and
buffering are separately proved by the native spoken-replies journey.

The replay also sends real neo.message.send input through the RPC door and reads
its stored SDK prompt: require [input: live_voice; speech: on] followed in that
same text block by the human-approved speak-first instruction. Every live voice
input with speech on carries it; typed, dictation and speech-off inputs do not.
The focused intake suite checks that matrix. Preserve original human content and
the existing system prompt; this is a per-input instruction, not a tool gate.

Production synthesis uses the operator-provided HYPERNEO_SPEECH_URL base, with
/v1/audio/speech and /v1/audio/voices beneath it; the phone does not configure
a second TTS endpoint. The audio opt-in receives pcm16 mono24kHz, ordered base64
chunks no larger than3840 bytes, then end; playing/played remain phone receipts.
The verify wrapper supplies a loopback synthetic upstream and must never inherit
that production setting or any credentials. Successful local synthetic streaming
does not establish the health or speed of the production GPU service.

For failure isolation, run the focused neo-speech suite through Vitest. Inject an
upstream read failure followed by a rejected failure-receipt write: the next
healthy request must still synthesize and deliver audio/end, with no unhandled
rejection. Catalog calls with missing, unavailable or invalid backend configuration
must complete with ok:false and a fixed reason; valid voices still return and an
unexpected infrastructure exception remains a failed operation.
The real WebSocket proof also flips only its synthetic catalog upstream to503,
requires a completed ok:false speech_backend_unavailable result, restores the
upstream and requires a successful catalog before streaming the next utterance.
For transport failures it closes the synthetic upstream listener, requires the
same typed unavailable result through the real WebSocket door, restarts only
that listener and requires catalog recovery. Focused tests also require typed
unavailable results for fetch connection errors and timeout/abort rejections;
unexpected infrastructure errors still fail the operation.

`upstream <explicit-base-url>` mode checks an independently managed synthesis
service. Only run it with an explicitly authorized backend; it never changes
or stops that backend. Both the 503 toggle and listener-close failure injection
are limited to local synthetic mode. Upstream mode checks a healthy catalog and
streaming, and reports both injected-failure evidence flags as false. Invalid
backend configuration includes malformed URLs and missing schemes; both must
return invalid_speech_backend without attempting a network request.

Include neo-refusals.test.ts and operation-name-families.test.ts with the focused
speech/intake suite: catalog rejection codes need an actionable shared explanation,
and the registered speech operation names must remain sorted. The complete static
check alone does not execute those runtime registration guards.

For server latency diagnostics, require voice-timing.json from the same real
WebSocket/MCP replay. One speech id must connect queued, request_started,
first_chunk, first_chunk_sent and finished; a live input has its message id at
durable acceptance. The focused speech/intake/publication tests also hold the
writer or audio source to prove timestamps occur at their actual boundaries,
exclude text/PCM and preserve retry deduplication. Publication persistence and
playing receipts are server observations, never screen-visible or first-played
timestamps. Query exported timing events or explicitly selected daemon JSONL
files with voice-timing-read.py; it only prints fixed stages, ids and times.
No phone timing or exact input-to-say attribution is inferred from proximity.
