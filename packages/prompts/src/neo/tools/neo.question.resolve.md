---
id: neo.question.resolve
---
Resolve an open worker card from a cited saved standing rule or earlier human answer owned by this Neo. Retires the card, stores the answer and citation, and uses its existing worker delivery/hold path. Neo or the local user on its behalf may call this. This is agent resolution, never human approval; start and confirmation cards are refused. source is {kind:"rule",text} with the exact saved text or {kind:"answer",questionId} for a human-answered card. Leave the card open when neither source applies.
