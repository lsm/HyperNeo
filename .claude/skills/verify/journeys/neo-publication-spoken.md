# Current-listener speech with publication

Use the shared resource/isolation setup in SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/neo-publication-spoken.ts
```

The helper boots a real daemon with temporary HOME/data, no provider credentials,
an ephemeral port and no model or synthesis endpoint. The real MCP adapter
publishes; two real WebSocket clients listen and read the public history. Require
the publication to exist before speech, speech before text notification, no spoken
draft in history, silent dropping without a listener, no replay on retries or
reconnects, a single fallback say without republishing, and last-listener wins.
Speech uses the existing audit writer. Inspect observed.json and run-status.json;
all clients and the daemon must be closed before the wrapper removes the run.

Run neo-publication-spoken.test.ts, neo-publication-operation.test.ts,
neo-publications.test.ts and neo-speech.test.ts through Vitest. Hold append while
toggling the listener to cover publish-time races. Conflicts and failed writes
must not speak. New card-reply versions may speak once even though the existing
publication row is updated; retries of any old version must not speak again.
Spoken input is optional and limited to 500 characters. Ordinary publications,
verbatim text and previously saved history keep their existing format.

Ordering is persist without notification, dispatch speech, notify publication.
This is not a cross-network transaction or a visible-text barrier: a client can
independently read already committed text, and a crash can interrupt delivery.
Missing listeners, failed delivery or retry do not queue speech for later. The
receipt reports the current listener and transport acceptance, not playback.
The helper proves transport ordering; actual sound, device routing and a real
model's word choice remain outside this proof.
