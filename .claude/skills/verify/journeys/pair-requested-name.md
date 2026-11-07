# Submitted pairing name in pending devices

Read SKILL.md for isolation and build the web bundle. Choose a random free port other
than 8399 or 8499, then run:

```bash
VERIFY_WEB=1 bash .claude/skills/verify/pair-requested-name.sh "$PORT"
```

The script owns a test daemon with fresh HOME, data and DB. A synthetic browser
submits `Browser label` for a code created as `Code label`. Settings > Devices and
Neo's drawer must show `Browser label`, while the pending RPC retains `name` and
adds `requestedName`. It closes the browser and daemon and removes its run. Codes
and credentials are not printed. Without VERIFY_WEB it tests HTTP and RPC only.
