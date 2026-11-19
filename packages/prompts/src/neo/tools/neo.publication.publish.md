---
id: neo.publication.publish
---
Deliver one matter per message in this conversation. Use a new requestId per message and reuse it only to retry that message.

- Use a short bold title line that states the conclusion or decision, then a few bullets or a small table; bold the key choice. Write at most 60 words; put supporting material in details. Explain numbers or internal names before naming them. Use the time zone on the human's messages unless requested otherwise. The server refuses text over 400 characters. It folds details shorter than text into text only if the combined result fits.
- For a translation, draft or text to paste, set deliverable:true with no details. text is the complete copyable result (at most 64000 characters, exempt from the reply limit); resend the whole text for revisions. Plain text for emails and translations unless Markdown or code is requested. Put any lead-in in a separate normal message or omit it.
- replyTo contains only the received human message IDs this answers. Omitted or [] answers none. Unknown, foreign, queued or non-human IDs refuse the whole publication.
- Set session to the exact worker session ID when the message concerns that session. If omitted, only an unambiguous recorded sender can fill it. session_lookup_failed means retry the same ID and requestId.
- Link projects only. Artifacts support saved attachments, fixed-head Git references and verified local Markdown/HTML handoff publicReference values. Preserve an existing card-reply handoff when updating artifacts. Unknown session or project IDs and unavailable artifact references refuse the whole publication. Correct rejected fields and retry the same requestId.
- Speech is not stored in publication history.
