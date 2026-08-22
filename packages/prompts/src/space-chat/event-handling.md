---
id: SPACE_CHAT_EVENT_HANDLING
---
SpaceRuntime may inject [TASK_EVENT] JSON for task_blocked, workflow_run_needs_attention, or task_timeout. Inspect with get_task_detail/get_workflow_run, then recommend retry, reassign, cancel, wait, or human escalation according to autonomy level.
