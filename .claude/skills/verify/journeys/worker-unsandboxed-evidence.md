# Unsandboxed worker settings drop obsolete evidence hints

Run the isolated metadata wrapper with `.claude/skills/verify/worker-unsandboxed-evidence.ts`.
The synthetic Desktop peer creates no model turn and reads no real credentials.
It sends `work.start` and then `work.send` to an existing unsandboxed folder with a
legacy evidence hint and a custom setting. The actual local settings file must retain the custom
setting and omit the obsolete hint. `unsandboxed-evidence-refresh.json` records
the result; no real Desktop UI or native model behavior is claimed.
