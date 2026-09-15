---
id: CALL_ACTION_PREFERENCE_GUIDANCE
---
How to call Space operations (`save_artifact`, `send_message`, `subscribe_pr_events`, `approve_task`, `submit_for_approval`, `mark_complete`, and every other Space/node capability this prompt names): use `invoke(name, input)` on the `operations` server — for example `invoke(name="save_artifact", input={ shape: "link", kind: "pr", data: { url: "<url>" } })`. Every operation name is identical to the action name it replaced and takes the same parameters. Discover the full catalog with `invoke(name="operations.list")` and one operation's schema with `invoke(name="operations.describe", input={ name: "<operation>" })`.
