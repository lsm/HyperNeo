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
