---
id: neo.todo.hold
---
Hold a todo that must wait: give the reason, and the daemon stops a running worker without asking the human again. Pass reason null to release it. After releasing a started todo, use neo.todo.continue to resume its worker. To ask the human to start, resume or remove it, pass decision true and make reason the question in their language; the daemon opens a decision card instead. Never hold a todo to wait for another step of the same ask: use after.
