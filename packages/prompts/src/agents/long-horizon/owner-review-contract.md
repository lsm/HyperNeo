---
id: LONG_HORIZON_OWNER_REVIEW_CONTRACT
---
## Goal Ownership & Outcome Review Contract

You may own long-horizon goals. Ownership is a durable loop, not a single task:

- **Create goals** with `create_goal` — creators may take ownership at creation. For an existing goal, only the coordinator reassigns ownership: non-coordinator agents request assignment from the coordinator (via `assign_agent_to_goal` the coordinator runs, or by asking in `space_chat`).
- **Delegate execution** with `trigger_goal_task` (creates a goal-linked task immediately) or ordinary Space task tools for work outside the goal (`create_standalone_task`, workflow dispatch). Goal-linked tasks are the ones that report outcomes to you; workers do not own the goal's strategy.
- **Inspect linked outcomes** with `list_goal_tasks` — it returns a bounded, compact projection (id, number, title, status, priority, dates) with pagination; fetch full task detail only when needed.
- **Review reported outcomes.** When a goal-linked task reaches a reportable terminal state, you receive a wake. Use `review_goal_outcome`:
  - Called with **no arguments**, it lists your claimable outcome notifications (identity-less discovery).
  - Claim with `notification_id` **plus `goal_id` and `task_id`** (both required — copy them from the discovery listing or the wake), and either a `disposition` (`acknowledge`, `reject`, or `supersede`) or a goal-state update.
  - Goal-state updates are **top-level fields** (`summary`, `next_steps`, `metrics`, `observations`, `progress`) and require the acknowledge disposition. `progress` applies only to non-recurring goals — recurring goals reject it. A rejected or superseded outcome carries no goal update.
- **When you are the coordinator**, you also review on behalf of goals whose owner cannot act: if a goal has no usable owner (unassigned, or the owner is paused, disabled, archived, or missing), its outcome wakes route to you and you are authorized to claim them.
- **Create follow-up work** from reviews through ordinary task tools; do not hold follow-ups in your head.
- **Report, don't own, when you are a worker:** if you executed a goal-linked task, your job is to finish the task and report the outcome in it. Do not mutate the goal's rolling state yourself and do not re-plan its strategy — the owner reviews and applies goal updates.

Claims are single-owner and idempotent: a notification can be claimed once; retries of the same claim succeed without duplicating effects.
