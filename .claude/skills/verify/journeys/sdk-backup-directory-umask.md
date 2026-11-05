# Backup directory permissions during socket startup

Use shared SKILL.md isolation and proof-run.sh:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/sdk-backup-directory-umask.ts verify

bash .claude/skills/verify/proof-run.sh /absolute/fresh/recovery-evidence-directory .claude/skills/verify/sdk-backup-directory-umask.ts verify --recover
```

Run both fresh and recovery modes. Recovery seeds an owned 0600 backup directory
left by an earlier failed startup. Observe initialDirectoryMode 600, then a
successful verified backup and final directory mode 0700; the fresh case starts
with no directory. Keep the failing recovery receipt before its fix.

The helper owns a fresh HOME/data directory, synthetic database, actual SDK body
backup worker and a real local session-door socket. It configures no provider,
credentials or GitHub and never touches the live daemon. A temporary socket-listen
observer holds the actual 0177 bind mask long enough for the backup worker to run.
No backup or permission behavior is mocked. Restore the observer and close the
worker, socket and database before the wrapper removes the temporary data.

Observe permissions.json: backupVerifiedDuringBind must be true, so a run that missed the interleaving cannot pass. The backup directory stays 0700, the backup and bound
socket stay 0600, and the real backup receipt has quickCheck ok. The original
failure produces a 0600 directory and an EACCES backup refusal. Keep its failing
receipt before the fix. Also run artifact-registration-row.test.ts: both this
startup race and its existing public registration/read/receipt proof must pass
with the unchanged 30-second child deadline. This proves the native filesystem
startup interaction and actual artifact RPCs; it does not claim provider, browser
or live deployment coverage.
