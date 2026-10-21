## In-app previews: shared contracts (slice 2)

Run `preview-contracts.test.ts` with the daemon unit runner. It must reject
malformed/extra authority fields, unsafe byte counts, unknown refusal reasons,
oversized decoded chunks (including padding edge cases), invalid hashes and
inconsistent completion metadata. Old publication/todo projections omit the
optional `artifacts` field. Valid references contain identity and display hints
only; they authorize nothing. Limits are initial defaults, not worker overrides.

Repeat slice 1's isolated daemon capture/restart journey. Its helper now validates
a path-free preview reference and each actual handoff chunk against the new
schemas, without changing the existing operation door. Complete bytes/hash must
still match. Repeat the headless actual Markdown renderer component suite.
This Build slice does not register `artifact.file.*`, accept publication artifacts,
persist references or expose preview UI. Publication/card wiring is slice 12;
UI/browser and human iOS containment evidence remains in its assigned slices.
No unattended GUI, provider, credentials, real files or live database are used.
