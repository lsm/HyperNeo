---
id: neo.topic.merge
---
Fold one topic you picked into another: rewrites the stored topic from `from` to `to` on every ask, open or settled, matching `from` with case and spacing folded, and returns how many asks changed. Use it when two picked topics name the same lasting area, so the topic list drops `from` and later asks reuse `to`. Project topics are never rewritten: they come from the project's title.
