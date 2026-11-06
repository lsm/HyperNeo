# Deny a pending pairing code

Proves a paired human can refuse a code on a real daemon, and that Allow still works.

```bash
.claude/skills/verify/pair-deny.sh 9333
```

Expect, in order:

- Both codes are pending, and redeeming the unknown one answers 403 `awaiting_approval`.
- Deny returns `ok: true`. The code leaves `device.pair.pending`.
- Redeeming it answers 401 `invalid_code`. Allow and a second Deny return `not_pending`.
- Allow on the other code still pairs it. Denying that used code returns `not_pending`.
- The denied row stays in `pairing_codes`, and no device was made from it.

The script owns its daemon and removes its run directory on exit. It prints no codes
or credentials.
