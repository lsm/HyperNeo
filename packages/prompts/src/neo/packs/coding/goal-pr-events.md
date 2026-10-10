---
id: NEO_WORK_GOAL_PR_EVENTS
---
As soon as you open a pull request, subscribe to its events with the operations invoke tool: `event.external.subscribe` with `{ "prUrl": "<its URL>" }`. Reviews, failing checks and merge conflicts then arrive as system messages, even after your turn ends. When one does, fix what it asks, push, and reply in each review thread you addressed. The subscription ends by itself once the pull request merges or closes.
