# Device pairing confirmation

A pairing code identifies a single-use request, not a trusted device. Codes expire
after ten minutes. Existing authorization, terminal approval and requester binding
remain unchanged.

For two-way requests:

1. The trusted computer displays a QR code containing the pairing code and address.
2. The phone scans it and confirms the request. The phone shows an eight-letter
   confirmation code formatted `XXXX-XXXX`.
3. The trusted computer asks the human to type that code. The pending list exposes
   `twoWay` and `phoneConfirmed`, never the confirmation code or fingerprint groups.
4. `device.pair.approve` takes `{codeId, confirmCode}`. Spaces and hyphens are removed
   and letters uppercased before comparison. A wrong or missing code denies the
   request permanently; the human must scan a new QR code. Approval before the
   phone confirms is refused without denying the request.
5. Only the bound requester can redeem the approved request, once.

Settings and the Neo drawer disable Allow until the phone confirms and an
eight-letter code is entered. Deny remains available. Ordinary one-way requests
still use `{codeId}` without a confirmation field. The QR CLI prints no fingerprint
or expected confirmation code; it prompts `Type the code shown on the phone:`.

## Coordinated rollout

This is a breaking change to two-way pairing, not a rolling-compatible upgrade.
A phone build that displays fingerprint groups or sends `lastGroup` cannot use
this flow. The strict approval schema refuses `lastGroup` before any approval or
denial write; it does not translate groups into a confirmation code. A missing
`confirmCode` in an otherwise valid approval still denies the request.

Before enabling scanned pairing, coordinate the daemon/CLI/web deployment with a
phone build that displays the eight-letter code, reads `phoneConfirmed`, and sends
`confirmCode` when approving. Check the shared vector below in both builds. Merge
alone does not authorize deployment or establish phone compatibility. Keep scanned
pairing unavailable until the matching phone build is installed; existing paired
credentials and ordinary one-way requests are unaffected.

After both sides are installed, discard any QR request begun with an older build,
scan a fresh code, and run an attended phone-to-computer approval and wrong-code
denial check. Do not fall back to fingerprint approval during a mixed-version
rollout. Native phone validation remains a release gate beyond the browser proof.

## Shared derivation

Normalize the pairing code by stripping spaces and hyphens and uppercasing.
`codeHash` and `requestedBy` are the SHA-256 hex digests of that normalized code
and the request ID, respectively. Hash their concatenated hex strings again.
Read the first 16 hex characters as an unsigned 64-bit integer. Repeatedly select
`BCDFGHJKLMNPQRSTVWXZ[n % 20]` eight times, divide by 20 after each selection,
reverse the selected letters, and insert a hyphen after four letters.

The synthetic interoperability vector is pairing code `abcd-efgh 23` and request
ID `00112233445566778899aabbccddeeff`, producing `MRNV-JHMH`.

Wrong-code failures retain the `wrong_fingerprint` reason identifier for existing
error handling; its message describes the new confirmation code and denial.

## Existing gap register

These IDs retain the earlier review anchors. The table records the original gaps
and proposed follow-ups, not a claim that every gap remains open. This confirmation
change does not close the G5 re-pair shortcut or G6 own-device removal work.
G7 enforcement remains tracked in [daemon security](daemon-security.md).

| Gap | Confusion, stall or safety limit | Smallest fix / repo |
| --- | --- | --- |
| G1 | An unpaired phone sees pending rows and an unusable Allow; “Your device” falsely suggests self-approval. | **HyperNeo:** apply the existing paired-human gate to pending management too. **neo-ios:** hide approval controls when refused; label the kind “Phone or browser” and the section “Codes waiting for Allow”. Keep the server's Allow gate. |
| G2 | Allow changes only a record; phone says “Waiting” indefinitely and browser requires manual resubmission. | **neo-ios + HyperNeo web:** keep a foreground waiting state and retry the existing POST every two seconds after 403. Stop on success, 401, cancel or leaving the flow; pause offline/background and resume explicitly/when foreground. Respect 429 retryAfterMs. Keep the code only in memory; no push channel or new store. |
| G3 | Lists age while open; offline approvers and expired rows offer stale actions. 401 copy omits reused codes. | **HyperNeo web + neo-ios:** refresh on reconnect/focus, offer Refresh, disable offline/expired Allow using existing expiresAt, show expiry and “invalid, expired or already used”. Keep the same code while awaiting approval; obtain a new one after 401. Web currently loads only on mount/action (`DevicesSettings.tsx:123`); iOS on connection/pull (`SettingsView.swift:139`). |
| G4 | A code issued by someone else looks like a device the human started; there is no Reject/Cancel action. Names are unverified and can differ from the redeeming name. | **HyperNeo daemon + both UIs:** say “Only allow a code you requested”; add Cancel that expires the existing code row under the paired-human/local-CLI gate. Never infer identity or consent from its name; unknown codes stay unusable. No new approval layer. |
| G5 | Web Re-pair cuts off the old device before success; iOS Pair again leaves an extra active credential behind. | **HyperNeo web + neo-ios:** remove the ambiguous shortcuts. Use explicit confirmed Remove, then Make code / Pair; warn about immediate disconnect, expiry and last-human recovery. Do not offer Pair again while the current pairing is valid. Reuse existing operations. |
| G6 | Removing one's current browser has no UI path; iOS cannot list/remove paired devices. | **neo-ios:** expose existing device.list / device.revoke. **HyperNeo web:** offer explicit own-device removal with confirmation. Both show an expected disconnect and the other-device/local-CLI recovery route; preserve history. |
| G7 | Revoke closes sockets, but report-mode reconnect still works without authority; iOS can still say paired because a local credential exists. Removal is not yet an access barrier. | **HyperNeo + neo-ios:** show report-only/revoked status and derive management authority from the daemon, not local credential presence. Actual unpaired-access enforcement remains the separately held S8/S9 work in `daemon-security.md:198`; this design does not enable it. Source: `packages/daemon/src/lib/pairing/upgrade-auth.ts:39`; iOS `NeoStore.swift:45`, `SettingsView.swift:44`. |
