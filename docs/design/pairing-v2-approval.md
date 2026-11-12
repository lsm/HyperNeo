# Pairing v2 approval admission

`/pair2/approve` admits any active paired human phone: a `paired_devices` row
with `kind = 'human'` and `revoked_at IS NULL`, excluding `local-rpc:*` and
`agent-read:` synthetic ids, regardless of pairing version or owner bit. The
same set decides bootstrap eligibility and, once the pending list lands, its
admission. Identities minted by the local transport (`local-rpc:*`) and
read-only agent credentials (`agent-read:*`) are refused on every request. Deny
and cancel only terminate a request; they keep the authenticated human-session
admission, including the web session.

A ticket issued while no active paired phone exists is a first-device ticket.
Its completion needs only the bound-key proof and atomically rechecks that no
active paired phone exists, so it grants the first device and its owner bit with
no separate approval. A later-device ticket cannot become a bootstrap ticket if
the existing devices are removed.

The approve route refuses first-device requests: they never appear as approvable
and completing one after another phone has paired returns `superseded`. Legacy
typed-code pairing remains available and shares the same atomic active-phone
check inside its grant transaction: if either path grants the first device, the
other path refuses its outstanding first-device attempt. A first-device grant
also un-approves unused human pairing codes; a later-device completion leaves
them alone.
