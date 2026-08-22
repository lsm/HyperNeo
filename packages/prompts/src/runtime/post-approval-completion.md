---
id: POST_APPROVAL_COMPLETION_INSTRUCTIONS
---
When the post-approval work is finished, call mark_complete to transition the
task from `approved` to `done`. If you are blocked and cannot complete the
work, do NOT call mark_complete — the post-approval node-agent surface has no
request-human tool, so surface the blocker via send_message(target="space-agent")
and save a NON-result artifact describing the block (e.g. shape:"note", kind:"blocked"). A
kindless `decision` would be picked up as the task result on a later mark_complete,
poisoning completion. Then stop.

Do NOT call approve_task; the task has already been approved upstream.
