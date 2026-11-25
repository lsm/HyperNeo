# Release SDK network smoke

Read shared SKILL.md first. Build the compiled CLI for the host target using the
release workflow's build steps, then run `bun scripts/sdk-runtime-check.ts
<compiled-binary> --network` with a disposable HOME and TMPDIR outside the
checkout and no provider credentials. Use Bun 1.4.2 and include npm on PATH.
The command must report that both SDK runtimes started, then that a download
interrupted by the local registry mirror succeeded on a subsequent attempt.
Retain the output and exit status. The mirror uses the public npm registry.

The npm downloader starts a fresh request after failure. If npm is unavailable,
the curl fallback instead retains a partial file and resumes it with a range
request. Exercise both paths when changing downloader selection or recovery.
