---
id: neo.todo.hold
---
Hold a todo that is waiting to start, or pause one that is running, to ask the human whether it goes ahead. reason is the card's whole text: your question to the human in their language, naming what waits, why it needs them, and that Start or Resume goes ahead and Remove drops it. The daemon stops a running todo's worker and opens that card with Start or Resume and Remove; the card is the hold, and the human's answer releases it. reason null releases a todo held by an older start answer. Hold only what the human said must wait.
