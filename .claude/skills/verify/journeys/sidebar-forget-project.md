# Forget an empty sidebar project

Build the web app, then run `.claude/skills/verify/sidebar-system-repro.sh <evidence-dir>`.
The script owns an isolated daemon, synthetic projects and one chat. It pairs a headless
browser and cleans up. Set `VERIFY_BROWSER`, `VERIFY_NODE` and `PLAYWRIGHT_NODE_PATH`
when needed, as in the sidebar new-session journey.

The light desktop screenshot shows the empty Neo project's remove control. The browser
checks that a project with a chat and a project with a hidden worker both refuse removal.
It invokes forget directly to check the worker guard, then verifies that an injected
failure shows an error and retains the project and folder history. Confirmed removal
stays gone after reload; a synthetic file and unrelated chat must remain. The run prints each observed result and exits nonzero
on failure.
