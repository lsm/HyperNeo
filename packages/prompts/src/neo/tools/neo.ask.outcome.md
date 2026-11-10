---
id: neo.ask.outcome
---
Record the settled focused discussion outcome on an open ask owned by this Neo. Use only an explicit report from ask.focusedSession after the human says the discussion is settled, naming this ask and its decision, documents and PRs. outcome is concise Markdown with document/PR references, not inferred approval from a relayed turn. This keeps the ask and its todos open, preserves its session link and does not stop or dispatch work. Track agreed execution using existing todos and pack checks; neo.ask.settle refuses done while todos are unfinished.
