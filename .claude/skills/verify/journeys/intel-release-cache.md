# Intel release cache

Read shared SKILL.md first. Run heavy builds only on CI.

After this workflow reaches the default branch, dispatch Warm desktop caches on
dev and require all four jobs to succeed. For each target, confirm the Cargo cache
was restored or saved on dev. Dispatch Release with publish disabled from a
different ref at the same commit and require each desktop job to restore its
target's cache from dev. Check that each build and artifact upload succeeds, and
that both macOS jobs sign and notarize successfully. Report both run URLs, each
cache restore line and each job duration alongside the cold baseline. A cache
hit alone does not prove the release build succeeds.
