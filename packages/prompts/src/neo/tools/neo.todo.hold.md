---
id: neo.todo.hold
---
Hold a todo that must wait: give the reason, and the daemon stops a running worker without asking the human again. Pass reason null to release it. After releasing a started todo, use neo.todo.continue to resume its worker. To ask the human to start, resume or remove it, pass decision true and make reason the question in their language; the daemon opens a decision card instead. Never hold a todo to wait for another step of the same ask: use after. The human sees the reason as what the step waits on, so name that thing, such as the PR that must merge. When the step waits on the human, ask them with decision true or neo.question.ask instead of a plain hold.

When it waits on a PR, set until so it releases on merge: {pack: "coding", kind: "pr_merged", params: {urls: [...]}} with the exact PR URLs. Set reviewAt to an epoch timestamp in milliseconds up to 30 days from now, or use the default of one day for a plain hold and seven days for a conditional hold. Neo is reminded if a named PR closes without merging or the review time arrives. Decision cards accept neither field.
