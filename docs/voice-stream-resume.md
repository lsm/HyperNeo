# Resumable voice-stream RPC

Paired-device streams remain in daemon memory for 120 seconds after disconnect.
Recovery across connections requires the same paired device,
using the stream ID received from start. It moves chunk ownership and future
text events to the new connection. No iOS changes or deployment accompany this
slice; clients must opt in only when start advertises `resumable:true`.
Unpaired streams advertise `resumable:false`, remain connection-owned and close
on disconnect as before. Knowing a stream ID alone never grants another unpaired
connection access to its audio. An unpaired caller can query its own stream on
the same connection, but cannot recover it across connections.

| Method | Request | Successful response |
| --- | --- | --- |
| `voice.stream.start` | `{encoding:"pcm16", sampleRate:16000, language?:"zh"\|"en"}` | `{streamId, via:"streaming"\|"batch", resumable:boolean, fallback?:string}` |
| `voice.stream.chunk` | `{streamId, audioBase64, offset?:number}` | `{ok:true}` |
| `voice.stream.resume` | `{streamId}` | `{ok:true, receivedBytes:number}` |
| `voice.stream.stop` | `{streamId}` | `{text:string, via:"streaming"\|"batch"}` |
| `voice.stream.cancel` | `{streamId}` | `{ok:true}` |

Offsets and receivedBytes count **decoded PCM bytes from the start of the
recording**, excluding any WAV header and base64 encoding. An omitted offset
appends exactly as before. An offset is a nonnegative safe integer. A replayed
prefix is dropped; only its unseen tail is appended and forwarded to ASR. Fully
received chunks are acknowledged without another ASR write. Any newly appended
tail must still contain whole PCM16 samples. Replayed bytes do not consume the
cumulative audio limit again. A forward gap is refused, never padded with silence.

The RPC response envelope carries a human-readable `error` string and a separate
`errorCode` field. Typed MessageHub clients expose the latter as the rejection's
`code`:

| Method | errorCode | Client action |
| --- | --- | --- |
| resume | `VOICE_STREAM_NOT_FOUND` | Unknown, expired, cancelled, stopped or other-device stream. Use the client's explicit fallback policy. |
| chunk | `VOICE_STREAM_INVALID_OFFSET` | Fix a negative, fractional, unsafe or nonnumeric offset. No audio accepted. |
| chunk | `VOICE_STREAM_OFFSET_GAP` | Resume to read the contiguous receivedBytes, then resend from that offset. No audio accepted. |

Other existing start/chunk/stop errors retain their messages and handler-error
behavior, including ownership, size, sample alignment and transcription failures.
The daemon keeps its existing stream-count, rate and audio limits. A successful
new start replaces detached recordings of the same paired device,
so paired legacy reconnects do not accumulate abandoned streams. It preserves other
owners and live connections. A failed start keeps the detached audio resumable;
capacity is checked again after opening if ownership changed while awaiting ASR. Resume cancels
the disconnect deadline; a later disconnect starts a new full grace period,
independent of the connected idle deadline. A timer retires abandoned streams
even without another RPC. Grace expiry also closes the ASR relay.

Suggested client flow: retain the stream ID and immutable PCM bytes, send
absolute offsets, reconnect with the same identity, call resume, resend from
receivedBytes (overlap is safe), then stop. Stop returns the transcript for all
unique audio, and final text events target the rebound connection. Interim text
missed while disconnected is not replayed. Successful stop/cancel retires the
stream; this protocol does not persist audio or completed stop responses across
daemon restarts. Clients without offset/resume retain their existing path.

Cancel also retires a detached stream when called by its paired owner, without
requiring resume first. It does not cancel another live connection's stream,
even for the same paired device. Unknown or foreign cancel remains an idempotent
`{ok:true}` no-op.
