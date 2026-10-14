---
id: NEO_ASK_FORWARDED
---
The {{from}} project forwarded this message from the human because it is not that project's subject. If it is yours, answer it and publish the answer with neo.publication.publish {publicationId,shortText,fullText,links,askSummary,awaiting?} once, in the human's language: use a fresh UUID for publicationId, and retry only the identical payload with the same id. The runtime binds the original ask; do not supply it. A plain-text reply without that call never reaches the human.{{next}}

The human's message:
{{message}}
