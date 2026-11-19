# Voice providers: pick a service, give it a key

Status: proposal, 2026-11-16; revised 2026-11-18 (cards instead of a settings page);
revised 2026-11-19 (how a card answer reaches the voice settings); revised again
2026-11-19 (review fixes: atomic apply, same-second and stale-URL refusals); revised
once more 2026-11-19 (two-value URL card, pair check in the transaction, conditional
web save).
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
  recorded preference rows, maps the provider through the preset table, and writes the
  three parts to the same settings store the web form uses, preserving every other voice
  field (keys, `enabled`, mode, TLS switches) and publishing the settings update so the
  form reflects it. Rows reach the table on two paths, both stamped `set_by: 'human'`: a
  card answer, and the `pack.preferences.set` operation, which is authorized for the
  local human user only (`safetyClass: 'human_only'`, `preference-operations.ts`). The
  stamp records the writer's claim of human authority, not which path wrote it. The web
  pack-settings form renders enum preferences only and exposes no voice fields
  (`PackSettings.tsx` shows the delegation pack; this design adds no voice UI there),
  so for the voice pack the card is the only surfaced source of rows — and the apply
  does not rely on that fact or the stamp: for `custom` it accepts only a provider row
  and a URL row committed together by one card answer, which is what makes the
  card-approval claim hold for voice. Neo writes neither the rows nor the settings.
  For "My own server" the base URL is itself a pack preference (`baseUrl`, text), asked on
  its own proposal card that shows the literal URL the human typed in chat before it is
  saved, and the apply refuses a URL that is not a valid `https://` address. No URL
  travels as an operation argument. The URL card is a two-value card: it records
  `provider: custom` and the `baseUrl` together, so the approval names the selection it
  applies to, and one answer commits both rows in one transaction with one `set_at`.
  Answer time alone cannot bind them — a card issued for an earlier custom selection,
  answered late, would otherwise upsert a URL that looks newer than the current
  provider row (`applyPackPreferenceAnswer` stamps `Date.now()` at answer time and
  checks no other row). With the pair on the card, a late answer is faithful: it
  commits exactly the pair the human saw on that card. Inside its write transaction
  the apply re-reads both rows and refuses `base_url_stale` unless they share one
  `set_at` — one card commit. That rejects a URL row left over from an earlier
  selection (the away-and-back case: the provider card re-records its row alone, so the
  pair no longer matches), rows written outside a card, and a provider change that
  lands between the operation's first row read and its transaction. The check runs only
  when the provider row says `custom`, like its two sibling URL refusals; a leftover URL
  row from an old custom choice never blocks OpenAI or Deepgram. After a refusal the
  path is the same: a fresh URL card, which re-displays the literal URL.
  Two refusals guard what a blind write would break. A legacy inline key
  (`voice.apiKey`) is bound to whatever host the current recorded endpoint has
  (`resolveVoiceKey` checks that host, not the key's own `apiKeyEndpoint`), so when the
  preset would move the recorded endpoint to a different host the apply refuses
  `legacy_key_host_changed` — the rule today's web form already enforces ("Save the legacy
  voice key before changing the recorded host"); the per-host key field that makes saving
  it possible arrives with slice 5. And when the three parts the apply would write differ
  from the parts currently saved, the apply refuses `settings_changed_since_answer` if the
  global settings were written at or after the second of the newest recorded row. The two
  clocks are different sizes: `global_settings.updated_at` is a whole second
  (`datetime('now')`), a preference row's `set_at` is milliseconds, so an edit at .800 in
  the same second as an answer at .200 would compare as older than the answer and slip
  past a strict "after" test. The comparison therefore floors the row's `set_at` to its
  second and refuses when `updated_at` is on or after that second: the answer's own
  second counts as already written. Beyond that mismatch, the timestamp is coarse on
  purpose: many non-voice writers bump it (driver health, rule answers, model changes),
  and the operation cannot tell a
  voice edit from any other write — every refusal points the safe way and costs one fresh
  card, whose answer re-records the row and applies over whatever changed. When the saved
  parts already equal the preset's output the apply is a no-op success and writes nothing,
  so unrelated settings writes after a successful apply never block anything.
  The guards and the write are one step, not two. The operation re-reads the
  preference rows and the settings, re-runs both refusals, the `custom` pair check and
  the part-equality check against those reads, merges the three parts into the `voice`
  object it just read — the settings store merges at the top-level key, replacing the
  whole `voice` object, so preserved fields must come from that read — and writes, all
  inside one immediate transaction, publishing the update only after the commit. The
  write goes through the same path the web form uses — the settings manager into
  `packages/daemon/src/storage/repositories/global-settings-writes.ts` (`apply`) and
  `packages/daemon/src/storage/repositories/settings-repository.ts`, whose write notifies `global_settings`
  subscribers as part of the write — so the apply must not bypass it, or the form would
  miss the notification it refreshes from.
  A web edit that commits while the apply runs either lands first, and the transaction
  sees it and refuses, or lands after. Landing after is safe only if the web write is
  itself conditional: the voice form builds a full `voice` draft from the settings it
  loaded (`VoiceSettings.tsx`) and queues whole-draft saves, so a draft queued before
  the apply could commit after it and restore the old endpoints — the gateway strips
  daemon-owned keys (`keepNeoOwnedSettings`) but passes `voice` through. The web save
  therefore becomes a compare-and-set: the draft carries the `voice` object it was
  built from, `prepareGlobalSettingsUpdate` (`rpc-handlers/settings-handlers.ts`)
  refuses `voice_changed_since_edit` when the stored `voice` differs from that
  baseline — whatever field the save touches, a key-only save included — and the form
  then reloads and re-applies the human's edit onto the fresh settings. This lands
  with slice 5, the slice that touches the web voice form; the apply follows it, so no
  unconditional full-draft writer exists by then.
  The two commits — the card answer and the apply — are deliberately not atomic with
  each other. The human's answer lands first and is never
  rolled back; the apply is re-runnable — after a failure it retries, after a success it is
  a no-op — and a failure leaves the previous settings working with the choice recorded.
  The preference rows never gate what the daemon dials — the settings are the only source
  of truth for behavior; a row only stops the question being asked again and labels the
  choice on later cards.
  Layering: the preset table and the operation live with the other voice mechanics in
  `lib/voice/`, registered beside the three test operations; a minimal always-enabled
  `voice` pack (one brief, the two preference declarations, instructions — the shape of the
  delegation pack) owns the human-facing questions, because only a pack can declare a
  preference. The Neo core outside `neo/packs/` is unchanged; the pack is additive.
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
default and target branch), near the repository's 300-line budget, failing tests first.

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
   and voice. The voice save becomes a compare-and-set: the draft carries the `voice`
   object it was built from and the handler refuses `voice_changed_since_edit` on a
   mismatch, so a queued draft cannot overwrite settings saved after it was built — the
   preset apply's write included.
6. **Tests Neo can run — merged (#11177).** All three test operations, and saving a key
   wakes Neo with an attention event naming the host (never the key).
7. **The provider card, re-cut.** The choice is recorded by the existing card machinery and
   applied by the operation above; the Neo core outside `neo/packs/` is unchanged.
   - **7a. The provider preference and its apply operation** — about 360 production lines,
     280 test lines, measured against the code it copies: the delegation pack
     (`neo/packs/delegation/pack.ts`, 89 lines) for the pack, the three test operations
     (`voice/test-operations.ts`, 164 lines) as the floor for one operation with row
     reads, five refusals and a transactional write, and the settings repository's merge
     path (`packages/daemon/src/storage/repositories/settings-repository.ts`, 146 lines) for the write. That
     is over the 300-line budget; if it lands there in code, the slice splits in two —
     the pack and its two cards first, the preset table and the operation second — with
     no other change to this design.
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
       `custom`), then one immediate transaction that re-reads the preference rows and
       the settings, re-runs the `base_url_stale` pair check (for `custom` only), the
       `legacy_key_host_changed` and `settings_changed_since_answer` guards and the
       part-equality check against those reads, merges the parts and writes through the
       settings gateway, publishing the update after the commit; registered in
       `rpc-handlers/index.ts` beside the test operations, name added to
       `shared/src/types/operation-names/neo.ts`, tool description in
       `packages/prompts/src/neo/tools/voice.applyProviderPreset.md` with its import and
       registry entry in `packages/prompts/src/mod.ts`.
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
| A legacy inline key, then a preset whose recorded host differs from the current one | refused `legacy_key_host_changed`; the inline key is never sent to the new host; after the key is saved per host or cleared, the apply fills the preset |
| Parts edited on the web after the card was answered, then the apply | refused `settings_changed_since_answer`; parts unchanged; a fresh card answer applies over them |
| A web voice edit in the same second as the card answer, parts differing from the preset | refused `settings_changed_since_answer` — the answer's own second counts as written; parts unchanged |
| Custom chosen, URL approved, provider switched away and back to custom, apply before a new URL card | refused `base_url_stale`; parts unchanged; a fresh URL card answer applies |
| A URL card issued for an earlier custom selection, answered after the provider was re-chosen to custom | the answer commits the pair shown on that card (provider and URL, one `set_at`); a later provider-only answer breaks the pair and the apply refuses `base_url_stale` |
| The provider row changed between the operation's first row read and its write transaction | the transaction re-reads the rows, the pair no longer matches, refused `base_url_stale`; parts unchanged |
| The web voice draft loaded before the preset apply, saved after it | refused `voice_changed_since_edit`; the form reloads and re-applies the edit; the applied parts stand |
| A key-only save from a draft loaded before the preset apply | refused the same way; no key or old endpoint is written over the applied parts |
| A web edit committed while the apply transaction runs | the edit is either seen inside the transaction and the apply refuses, or commits after it — a voice save only with a matching baseline, so it lands on the applied parts; no edit or saved key is lost |
| A non-voice settings write (a rule answer, a model change) after the card was answered, then the apply | the parts still differ from the preset, so it is refused the same way; after parts equal the preset (a successful apply), the same write never blocks a re-run |
| The apply run twice | the second run is a no-op success — the parts already equal the preset, so nothing is written and the settings timestamp is untouched |
| Parts edited on the web after an apply | behavior follows the settings; the preference rows are not consulted |

## Out of scope

ElevenLabs, Azure, Google and AssemblyAI. Each is one more adapter behind the same
interfaces when someone needs it.
