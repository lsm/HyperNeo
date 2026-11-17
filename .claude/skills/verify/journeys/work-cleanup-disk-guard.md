# The disk guard warns Neo and holds new starts at the floor

Step 6 of the work cleanup. The Neo 5-minute pack sweep reads free space on the
data volume. Below 50 GiB it tells Neo in the digest. Below 10 GiB it wakes Neo,
queues one `work.cleanup.sweep` backstop and holds new worker starts. Running
work continues, and recovery above the floor releases the hold.

Use the isolated metadata-only setup in `../SKILL.md`. The helper takes the
level it expects the data volume to be at:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-cleanup-disk-guard.ts warn
```

Run `warn` on a volume with 10 to 50 GiB free. For `floor`, put the run on a small
disk image so its free space is truly under 10 GiB (macOS):

```bash
hdiutil create -size 512m -fs APFS -volname floor /tmp/floor.dmg
hdiutil attach -nobrowse -mountpoint /tmp/floor-mnt /tmp/floor.dmg
TMPDIR=/tmp/floor-mnt bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/work-cleanup-disk-guard.ts floor
hdiutil detach /tmp/floor-mnt && rm /tmp/floor.dmg
```

The helper starts an isolated daemon with its job processor running, seeds a
Neo root session and an approved todo with a HyperNeo start, then runs the
pack sweep job twice.

- `warn`: one digest entry in `neo_notes` says the volume is under 50 GiB, only
  `disk:warn` is in `work_cleanup_gone`, no backstop is queued, and the queued
  todo's start is attempted.
- `floor`: one wake entry in `mailbox` says the volume is under 10 GiB,
  `disk:warn` and `disk:floor` are recorded, exactly one disk backstop job is
  queued across both sweeps, and the queued todo stays `todo` with no start.

`work-cleanup-disk-guard.json` records the free space, the entries, the rows and
the todo. Recovery above the floor is covered by the focused contract, not this
proof, because a disk image cannot grow past the floor mid-run:

```bash
cd packages/daemon && bun test tests/unit/1-core/work-cleanup/disk-guard.test.ts tests/unit/1-core/work-queue
```
