# Forget a sidebar project

Build the web app, then run `.claude/skills/verify/sidebar-system-repro.sh <evidence-dir>`.
The script owns an isolated daemon, synthetic projects and one chat. It pairs a headless
browser and cleans up. The browser forgets a project whose only chat is archived,
checks that the chat is still archived through RPC, and checks that the project stays
gone after reload. Set `VERIFY_BROWSER`, `VERIFY_NODE` and `PLAYWRIGHT_NODE_PATH`
when needed, as in the sidebar new-session journey.

The desktop screenshots show the remove control, confirmation, disabled reason and error.
Set `VERIFY_COLOR_SCHEME` to `light` or `dark` to capture both appearances. The browser
checks that the protected Inbox and projects with a chat, hidden worker, or uncheckable
remote work refuse removal. A simulated offline peer cannot block a local folder check. A two-folder history project disappears without deleting
files; a stale folder reports failure and leaves the other membership intact.
A project without folders or other workspace aliases can be forgotten. An unrelated
session update does not trigger another work scan. Run again with
`VERIFY_INJECT_FAILURE=1` to simulate an unreachable local work source and confirm the
control becomes available after the next project list refresh.
It invokes forget directly to check the worker guard, then verifies that an injected
failure shows an error and retains the project and folder history. Confirmed removal
stays gone after reload; a synthetic file and unrelated chat must remain. The run prints each observed result and exits nonzero
on failure.
