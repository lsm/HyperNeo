---
id: work.queue
---
Queue next-turn peer input by ref. Ordinary local Neo messages are stored durably with an inputId and delivered after the worker leaves running or queued status. A question ending the turn permits delivery. Explicit steer stays immediate. An agent send needs a todo on an accepted human request; Neo may use notice: true only to reply to a session that messaged it. Returns an opaque queuedSubmissionId when supported; delivered false/unconfirmed does not prove execution. Only Neo or the user can change work on another daemon. Unsupported adapters return a factual rejection with no fallback.
