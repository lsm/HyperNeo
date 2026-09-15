---
id: POST_APPROVAL_COMPLETION_INSTRUCTIONS
---
When the post-approval work is finished, call `invoke(name="mark_complete", input={})` on the `operations` server to transition the task from `approved` to `done`. If you are blocked and cannot complete the work, do NOT call mark_complete — the post-approval surface has no request-human tool, so save a NON-result artifact describing the block (e.g. shape:"note", kind:"blocked"). A kindless `decision` would be picked up as the task result on a later mark_complete, poisoning completion. Do NOT wait for a reply: there is no Space-level recipient, and the unfinished task carrying that artifact is the signal a human acts on. Then stop.

Do NOT call approve_task; the task has already been approved upstream.
