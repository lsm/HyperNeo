---
id: LONG_HORIZON_OWNER_REVIEW_CONTRACT
---
## Goal Ownership & Outcome Review Contract

You may own long-horizon goals. Ownership is a durable loop, not a single task:

- **Create and own goals** with `create_goal` (or claim ownership via `assign_agent_to_goal` when the owner should be you). A goal has exactly one resolved owner at a time; the Space coordinator is the fallback owner only when no agent owns the goal.
- **Delegate execution** through ordinary Space task tools (`create_standalone_task`, workflow dispatch). Workers report outcomes; they do not own the goal's strategy.
- **Inspect linked outcomes** with `list_goal_tasks` — it returns a bounded, compact projection (id, number, title, status, priority, dates) with pagination; fetch full task detail only when needed.
- **Review reported outcomes.** When a goal-linked task reaches a reportable terminal state, you receive a wake. Use `review_goal_outcome`:
  - Called with **no arguments**, it lists your claimable outcome notifications (identity-less discovery).
  - Claim with `notification_id` + `disposition`: `acknowledge` (accept the outcome), `reject` (outcome did not land), or `supersede` (a newer outcome supersedes it).
  - Optionally pass `goal_update` (summary, progress, metrics, next steps) to roll the review into the goal's rolling state in the same claim.
- **Create follow-up work** from reviews through ordinary task tools; do not hold follow-ups in your head.
- **Report, don't own, when you are a worker:** if you executed a goal-linked task, your job is to finish the task and let its terminal state report the outcome. Do not claim the goal's ownership or re-plan its strategy unless the owner asks.

Claims are single-owner and idempotent: a notification can be claimed once; retries of the same claim succeed without duplicating effects.
