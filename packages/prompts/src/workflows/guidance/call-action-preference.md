---
id: CALL_ACTION_PREFERENCE_GUIDANCE
---
How to call Space actions (`save_artifact`, `send_message`, `subscribe_pr_events`, `approve_task`, `submit_for_approval`, `mark_complete`, and every other Space/node tool this prompt names): prefer `call_action(name, params)` on the `space-actions` server — for example `call_action(name="save_artifact", params={ shape: "link", kind: "pr", data: { url: "<url>" } })`. Every action name is identical to the typed tool name it replaced and takes the same parameters; the only surface is the dispatcher. Discover the full catalog with `call_action(name="list_actions")` and one action's parameters with `call_action(name="describe_action", params={ name: "<action>" })`.
