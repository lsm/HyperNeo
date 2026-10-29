# Opus input through resumable voice RPC

Use shared setup from SKILL.md and one heavy local job at a time. Run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/voice-resumable-streams.ts opus
```

The existing isolated-daemon journey now accepts `opus`. A deterministic 1 s
16 kHz mono tone is encoded at 24 kbps CBR in 20 ms packets using the pinned
codec. An independent decoder instance provides expected PCM. The daemon's
real decoder worker must deliver exactly those PCM bytes to the synthetic ASR.
Only hashes/lengths are retained for this mode; there is no human audio.

Require formats advertisement, code-1006 disconnect, encoded-byte resume at a
split length prefix, duplicate/overlap replay, exactly one final transcript and
byte-for-byte reference PCM at ASR. Malformed input must retire the stream;
incomplete stop must remain resumable and finish after receiving remaining
bytes. Legacy PCM16, takeover refusal, replacement and detached cancel remain
covered. The abandoned Opus stream must retain its ASR until 119 seconds, close
by 121 seconds and refuse resume. Wrapper and daemon must exit 0 and remove
all disposable data; pairing secrets must be absent from retained logs.

`opus-quick` skips only the real-time expiry check and is not full grace proof.
To exercise the real Deno daemon, leave the test controller on Bun and use mode
`opus-deno` with pinned Deno on PATH. The helper starts daemon/main.ts from its
workspace. Running the controller itself on Deno is unsupported: its Node child
process adapter reported signal status despite the shutdown-complete marker.
The proof still requires the daemon's actual exit code 0 and no signal.
To exercise a
Bun-compiled daemon, pass its absolute binary path between mode and the run
argument (the wrapper appends the run), for example:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/voice-resumable-streams.ts opus-quick /absolute/hyperneod
```

Compile with scripts/compiled-worker-entrypoints.ts so the decoder worker is
embedded. A source-only run does not prove compiled-worker loading. This is
public daemon RPC with synthetic ASR, not physical-phone or live-provider proof.
