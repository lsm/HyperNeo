# Recover a lost human device from the local CLI

From the worktree root, choose a free port other than 8399 and a fresh absolute run:

```bash
bash .claude/skills/verify/devices-reset-human.sh 9432 /private/tmp/verify-human-recovery
```

The helper owns a real CLI daemon and restarts it once with the same synthetic DB.
Both launches use `env -i`, `NODE_ENV=test`, a fresh HOME/data directory, no provider
keys, and only loopback. No real home, auth file, phone, GUI or live daemon is used.
Pairing codes and credentials remain in memory and never enter evidence or logs.

It pairs a synthetic phone and relay through CLI codes and public `/pair`, opens
their authenticated WebSockets, and observes that a network reset is refused.
`hyperneo devices reset-human` succeeds only through the owner-only session door:
the phone socket closes within two seconds, the relay still reads, all device
history remains, and the old pending code cannot pair. An active client receives
the publication-change event; public `neo.publication.read` shows the reset time
and cleared phone name/ID without secrets.

After an actual daemon restart, the local CLI's next human code needs no Allow.
The first successful human pairing consumes recovery, an extra recovery code now
needs Allow, and later CLI codes are pending again. Two further resets (including
one with no active human device) each retain another public notice. The original
device rows are never deleted. The helper stops both owned daemons and fails on
missing observations; evidence is `evidence/{initial,restarted}.json`.

Focused contracts also cover atomic rollback when notice persistence fails,
ordinary revoke never reopening bootstrap, and network/agent caller refusal.
This is report-only: S8/S9 and CORS are unchanged. Not verified: real phone push
delivery, SSH access, GUI rendering, or Deno execution.

For native Bun/Deno DB-worker and main-SQL-denial coverage of the same public CLI,
including lost-reply notification recovery, use
[reset activation](lane-c-human-reset-activation.md).
