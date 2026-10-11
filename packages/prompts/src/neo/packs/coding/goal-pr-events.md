---
id: NEO_WORK_GOAL_PR_EVENTS
---
As soon as you open a pull request, subscribe to its events with the operations invoke tool: `event.external.subscribe` with `{ "prUrl": "<its URL>" }`. When one of its events reaches you as a system message (a review, a failing check, a merge conflict), fix what it asks, push, and reply in each review thread you addressed. Once the pull request merges or closes, call `event.external.unsubscribe` with the same `{ "prUrl" }`.
