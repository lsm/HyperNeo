# Opus voice-stream input

Select the wire format with `voice.stream.start {encoding:"opus",sampleRate:16000}`.
An omitted encoding defaults to PCM16; an omitted sampleRate defaults to 16000.
Both successful formats advertise `formats:["pcm16","opus"]`, alongside the
existing streamId, via, resumable and optional fallback fields. Only paired
streams advertise resumable:true. The remaining RPC shapes are in
[the resumable protocol](voice-stream-resume.md).

## Wire format

Each packet is a two-byte **unsigned little-endian byte length**, followed by
exactly that many raw Opus bytes. Lengths are 1 through 1275. Packets must decode
to 20 ms of mono audio (320 samples at the daemon's 16 kHz output rate). There is
no Ogg/WebM/WAV header, timestamp or transport pre-skip. Every decoded sample is
retained; clients must transmit any encoder lookahead/flush padding needed to
cover the end of their recording. Do not drop the final encoder output.

Chunks may contain multiple packets or end anywhere within a length prefix or
payload. Base64 encodes these framed bytes. Offsets and resume.receivedBytes
count **encoded bytes including the prefixes**, before base64. Retain those
immutable bytes and resend from the returned offset; overlap is deduplicated
before decoding, including a partial packet retained across reconnect. Each
stream's asynchronous inputs are serialized, and stop waits for preceding
chunks. The decoded PCM remains subject to the existing 10 MiB audio limit;
queued encoded input is bounded by that same limit and 128 pending chunks.

A 24 kbps CBR encoder produces approximately 60 payload bytes per 20 ms packet.
With prefixes that is 3,100 bytes/s, or 0.186 MB/min, compared with 1.92 MB/min
PCM16. Base64 increases those figures to roughly 0.248 and 2.56 MB/min; RPC/TLS
framing adds overhead. The daemon decodes rather than re-encodes, so bitrate is
chosen by the client. DTX/VBR may change the actual byte count.

## Errors and lifetime

Errors retain top-level error and errorCode fields:

- `VOICE_STREAM_INVALID_OPUS`: malformed length/payload, wrong channel count or
  packet duration, or decoded audio exceeding its limit. The stream is retired;
  resume then returns `VOICE_STREAM_NOT_FOUND`.
- `VOICE_STREAM_DECODER_FAILED`: decoder startup, worker failure or timeout. A
  started stream is retired. A failed new start preserves prior recordings.
- `VOICE_STREAM_INCOMPLETE_OPUS`: stop encountered a partial prefix/payload.
  This remains retryable: send its remaining bytes and retry stop or cancel.

Existing offset, owner, grace and legacy handler errors are unchanged. Queue
admission failure accepts no bytes; a client may resume and retry. PCM16 retains
its original append and sample-alignment rules. Decoding uses the pinned,
self-contained libopus WebAssembly module in a dedicated worker; it requires no
external codec executable or runtime download. Workers close on stop/cancel,
replacement, disconnect expiry or a terminal decoding failure. Deployment and
native clients are outside this daemon slice.
