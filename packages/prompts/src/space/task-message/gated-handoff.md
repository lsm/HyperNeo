---
id: TASK_MESSAGE_GATED_HANDOFF
---
  - {{target}}: call `send_message(target={{target_json}}, message="<short summary>", data: { "pr_url": "<pr_url>" })`; `save_artifact` alone does not deliver this gated handoff.
