# Intel release cache

Read shared SKILL.md first. Run heavy builds only on CI.

After this workflow reaches the default branch, dispatch Warm Intel desktop cache
on dev and require success. Confirm its Cache Cargo post-step saved the Intel key
on dev. Dispatch Release with publish disabled from a different ref at the same
commit and require the Intel Cache Cargo step to restore that key from dev. Check
that the Intel build, signing, notarization and artifact upload succeed. Report
both run URLs, the cache restore line, and the Intel job duration alongside the
cold baseline. A cache hit alone does not prove the release build succeeds.
