---
id: neo.message.send
---
Durably accept a human ask into an open Neo conversation without waiting for its coordinator. Supply a new requestId UUID per ask and reuse it only for retries of identical content. Acceptance does not mean the ask has been processed or answered. replyTo {kind, id} quotes a question, todo, ask (work card) or message: every message and reply goes to the one Neo session, and a reply to a question is recorded as its answer, except a start question, where a reply is only a remark and the question stays open. For each photo, thumbnails may carry a small preview { index, mediaType, data, width?, height? } keyed by the photo’s content index; it is stored for conversation pages and never sent to the model.
