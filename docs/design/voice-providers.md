# Voice providers: pick a service, give it a key

Status: proposal, 2026-11-16; revised 2026-11-18 (cards instead of a settings page);
revised 2026-11-19 (how a card answer reaches the voice settings).
Design only.
Scope: the daemon's speech-to-text (recorded and live) and text-to-speech, and how the
human chooses them. Paths without a prefix are under `packages/daemon/src/lib/`.

## Why

A user should be able to point HyperNeo at the speech service they already pay for, or
at their own server, and have recorded voice, live voice and spoken replies all work.
The daemon supports these combinations, but the web form does not expose every setting.

## What exists

| Job | How it is configured | What it can talk to |
|---|---|---|
| Recorded voice to text | Web settings: "Batch endpoint", "Model", "API key" | OpenAI-shaped and Deepgram requests |
| Live voice to text | Web settings: "Live endpoint" | Deepgram and OpenAI Realtime; the form has no provider picker |
| Text to speech | Speech settings or the `HYPERNEO_SPEECH_URL` fallback | OpenAI-shaped and Deepgram requests |

The three parts and their providers are already supported by the daemon (slices 1–4).
The web form does not expose per-part providers or speech settings. One credential,
`voice-transcription`, is bound to one host: `resolveVoiceKey` checks each target host
before returning it, including for live streams and speech.

## The design

**Three jobs, each with a provider.** Voice settings hold three parts, each with its own
provider and address, with a model or voice where supported:

| Part | Providers in the first version | Wire shape |
|---|---|---|
| Recorded voice to text | `openai` (OpenAI and every server that copies it: Groq, self-hosted Whisper servers) | multipart to `/v1/audio/transcriptions`, `Authorization: Bearer` |
| | `deepgram` | raw WAV body to `/v1/listen?model=…`, `Authorization: Token` |
| Live voice to text | `deepgram` (exists) | as today |
| | `openai-realtime` | the Realtime API in transcription mode: `input_audio_buffer.append` frames, transcript delta and completed events. It takes 24 kHz PCM, so the daemon resamples the 16 kHz capture. |
| Text to speech | `openai` (OpenAI and self-hosted servers that copy it) | `POST /v1/audio/speech`, `response_format: pcm` (24 kHz, the rate clients already play, `neo/speech.ts`) |
| | `deepgram` | `POST /v1/speak?model=…&encoding=linear16&sample_rate=24000&container=none`, so the body is raw PCM like the `openai` adapter's, not WAV (`neo/speech-audio.ts` accepts only `audio/pcm`) |

Each provider is one small adapter in the daemon behind the seam that already exists for
live voice (`StreamProtocol` in `voice/stream-protocols.ts`). There is one adapter
interface for recorded voice and one for speech. The live seam gains one optional hook: a
protocol can mark a message as the end of the utterance. Today a stream finishes only when
the service closes the socket (`voice/asr-relay-core.ts`); the Realtime API instead sends
`conversation.item.input_audio_transcription.completed` and stays open, so without the hook
every final transcript would time out and fall back to batch. On that message the relay
settles the request and closes the socket itself. An adapter sends only the fields its
service defines; fields that only one self-hosted server knows, like `language: 'auto'`,
stay in that server's preset.

**Keys belong to a host.** A key is saved for a host name, and any part whose address has
that host uses it. One OpenAI key then serves all three OpenAI parts, and one Deepgram key
serves Deepgram's recorded, live and speech addresses. A key is still never sent to another
host, and never over plain HTTP or WS. The existing `voice-transcription` credential is read
as the key for the host of its saved `apiKeyEndpoint`, not of the current batch endpoint:
the two can already differ (the endpoint can change without a new key), and today such a
key is not sent. A legacy key stored inline in the settings belongs to the current batch
endpoint's host, as it does today.

**Voices.** The speech part has a voice field. The adapter offers a list: OpenAI's published
voices; Deepgram's from its model names; for a self-hosted server, its own
`/v1/audio/voices` when it answers. The user can always type a name. The default voice comes
from the preset, not from the code.

**Choosing on a card, not a page.** The new UI has no settings page, so the human sets
voice up by answering Neo:

- **Provider: a card.** Neo asks once, when voice first matters, through
  `pack.preferences.ask`: **OpenAI**, **Deepgram** or **My own server**. A choice, applied by
  `voice.applyProviderPreset` (next paragraph), fills all three parts with that preset
  (addresses, models, default voice); "My own server" uses OpenAI-shaped recorded and speech
  addresses plus a Deepgram-shaped live address on one base URL, and is followed by a second
  card for that base URL (below). Changing it later is the same card again.
- **Applying a card answer.** A preference card answer commits only preference rows, in the
  card machinery's own transaction (`applyPackPreferenceAnswer`,
  `packages/daemon/src/storage/repositories/pack-preference-answer.ts`); that transaction
  cannot also write the voice settings, and the storage layer must not know voice. So
  applying the preset is a second, explicit step: after the answer commits, Neo invokes one
  daemon operation, `voice.applyProviderPreset`, which takes no arguments. It reads the
  recorded preference rows — written only by a human answer (`set_by: 'human'`), never by
  Neo — maps the provider through the preset table, and writes the three parts to the same
  settings store the web form uses, preserving every other voice field (keys, `enabled`,
  mode, TLS switches) and publishing the settings update so the form reflects it. Neo
  cannot apply anything the human did not see and approve on a card.
  For "My own server" the base URL is itself a pack preference (`baseUrl`, text), asked on
  its own proposal card that shows the literal URL the human typed in chat before it is
  saved; the apply reads that row like the provider row and refuses a URL that is not a
  valid `https://` address. No URL travels as an operation argument.
  The two commits are deliberately not atomic. The human's answer lands first and is never
  rolled back; the apply is idempotent and re-runnable, and a failure leaves the previous
  settings working with the choice recorded. The preference rows never gate what the daemon
  dials — the settings are the only source of truth for behavior; a row only stops the
  question being asked again and labels the choice on later cards.
  Layering: the preset table and the operation live with the other voice mechanics in
  `lib/voice/`, registered beside the three test operations; a minimal always-enabled
  `voice` pack (one brief, the two preference declarations, instructions — the shape of the
  delegation pack) owns the human-facing questions, because only a pack can declare a
  preference. Core (`lib/neo/`) is unchanged.
- **Keys: the existing key field, never a card.** A key is a secret and must not pass
  through chat, a card answer or Neo's context. It is entered in the web voice settings'
  password field, the same place every other provider key is entered today, extended to
  one field per host the chosen parts use. The card that picks a provider ends with which
  host still needs a key and links to that field.
- **Tests: Neo runs them.** Three daemon operations Neo can call and report in plain
  words: `voice.testConnection` (recorded, as today), `voice.testLive` (opens the stream
  with streaming forced, sends one second of silence, closes it, and returns the service's
  error instead of falling back to batch) and `voice.testSpeech` (synthesizes one short
  sentence and returns whether audio came back). A returned error is the HTTP status and a
  short reason with every saved key's text replaced by `[key]` before it leaves the daemon, so
  a server that echoes the token never puts it in Neo's context. After a provider choice or a key save,
  Neo runs the three and says which part works.

- **One part or one voice: on request.** When the human asks to change one part, the
  recorded or speech model, or the speech voice ("use voice X"), Neo asks a card naming
  that part's choices (the adapter's voice list, or a typed name by reply). The web voice settings form gains
  fields for the same edits; no new page is built.

**Upgrade.** Existing settings map without loss: the batch endpoint and model become the
recorded part (`openai`), the live endpoint becomes the live part (`deepgram`, or its saved
`streamProtocol`). The speech part starts empty. While it is empty the daemon falls back to
`HYPERNEO_SPEECH_URL` with the same OpenAI shape and no key, so existing installs keep
speaking without any change. Nothing else reads that variable.

## What does not change

- The phone and web clients: they still record, stream and play through the daemon. They
  never see keys or provider addresses.
- Voice mode (`batch`, `streaming`, `auto`), the TLS and private-network switches, and the
  recording queue and retries.

## Change plan

Slices 1–4 have merged. Each remaining slice is one PR from `dev` (the repository's
default and target branch), about 100 to 200 production lines, failing tests first.

1. **Settings shape and keys by host — merged (#10845).** The three parts in `VoiceSettings`, the upgrade
   mapping, and key lookup by host. No new providers yet; behaviour is unchanged except that the live
   stream is sent a key only when its host matches the key's host.
2. **Speech from settings — merged (#10864).** Text to speech reads the speech part (OpenAI shape, with
   key), the environment variable becomes the fallback, the voice list comes from the
   adapter, and the `speech_backend_not_configured` refusal points to the voice settings
   instead of the variable.
3. **Deepgram recorded voice and Deepgram speech — merged (#10885).** Two adapters.
4. **OpenAI Realtime live voice — merged (#10887).** One adapter, with 16 to 24 kHz resampling, and the
   end-of-utterance hook in the live relay.
5. **Keys per host.** Store one key per host (today one key, `voice-transcription`,
   bound to one host in `resolveVoiceKey`, `voice/voice-parts.ts`), look a part's key up by
   its own host, keep a legacy key as today, and one password field per needed host in the
   web voice settings, plus fields for each part's provider and the speech address, model
   and voice.
6. **Tests Neo can run — merged (#11177).** All three test operations, and saving a key
   wakes Neo with an attention event naming the host (never the key).
7. **The provider card, re-cut.** The choice is recorded by the existing card machinery and
   applied by the operation above; core is unchanged.
   - **7a. The provider preference and its apply operation** — about 250 production lines,
     160 test lines:
     - `neo/packs/voice/pack.ts` (new): always-enabled pack with two global preferences —
       the enum `provider` (`openai`, `deepgram`, `custom`) and the text `baseUrl` for
       `custom` — and instructions telling Neo to ask once when voice first matters, apply
       the answer, then run the three tests and name the hosts still missing a key;
       registered in `neo/packs/index.ts` and constructed with the database in
       `neo/packs/runtime.ts`, like the delegation pack.
     - `voice/provider-presets.ts` (new): the preset table — the three parts for each
       provider, `custom` composed from one base URL.
     - `voice/apply-preset-operation.ts` (new): `voice.applyProviderPreset` as one pipeline
       with no input — read the recorded rows (refuse `provider_not_chosen` without the
       provider), map the preset (refuse `base_url_required` and `base_url_insecure` for
       `custom`), write the parts through the settings manager, publish the update;
       registered in `rpc-handlers/index.ts` beside the test operations, name added to
       `shared/src/types/operation-names/neo.ts`, tool description in
       `packages/prompts/src/neo/tools/voice.applyProviderPreset.md`.
   - **7b. On-request part, model and voice changes:** `voice.setPart` on the same write
     path; the part cards from the "one part or one voice" paragraph above.

Acceptance, one test per row: against local fake servers for requests and tests, and as
daemon integration cases for cards and Neo messages:

| Case | Expected |
|---|---|
| Settings saved before this change | same requests to the same addresses with the same key, except a live address on another host, which gets no key |
| Saved key whose `apiKeyEndpoint` host differs from the current batch endpoint | after the upgrade the key is still not sent to the batch endpoint |
| Fake Realtime socket that sends `completed` and stays open | the final transcript arrives without the timeout and the relay closes the socket; an error or a missing `completed` still cleans up |
| Deepgram speech against a fake server | clients receive raw PCM, no `RIFF` header |
| Each provider of each part | the request shape and auth header that service documents |
| One key, three OpenAI parts | the key is sent to all three; never to a part on another host |
| Speech part empty, `HYPERNEO_SPEECH_URL` set | speech works as today |
| Each test operation against a fake that succeeds, then one that fails | passes, then returns the service's error; the live test never falls back to batch |
| OpenAI recorded and Deepgram live, a key saved for each host | each part gets its own host's key |
| A provider chosen on the card | all three parts filled from the preset; the card names the hosts still missing a key |
| A key | never appears in a card, an answer or a Neo message |
| A fake server whose 401 body echoes the key | the test returns `[key]` in its place |
| `voice.applyProviderPreset` with no recorded `voice:provider` row | refused `provider_not_chosen`; settings unchanged |
| OpenAI chosen on the card, then applied | the three parts are filled from the preset, every key field (`apiKey`, `hasApiKey`, `apiKeyEndpoint`) and stored host key is unchanged, and the web form shows the new parts |
| "My own server", the base URL card answered, then applied with the URL row deleted before the apply | refused `base_url_required`; parts unchanged |
| A recorded `baseUrl` that is not a valid `https://` URL | refused `base_url_insecure`; parts unchanged |
| The apply run twice | the same settings; nothing duplicated anywhere |
| Parts edited on the web after an apply | behavior follows the settings; the preference rows are not consulted |

## Out of scope

ElevenLabs, Azure, Google and AssemblyAI. Each is one more adapter behind the same
interfaces when someone needs it.
