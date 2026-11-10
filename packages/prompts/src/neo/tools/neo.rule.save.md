---
id: neo.rule.save
---
Prefer neo.rule.ask for human confirmation first. Directly add or remove standing rules only with human approval: pass messageId from the approving human message’s [message id: ...] line. The daemon records that message reference with each added rule, so consent stays traceable; paraphrasing is allowed. The message must be a consumed human yes replying to the immutable neo.rule.ask proposal for these exact add/remove arrays in this Neo conversation; system notes and other sessions cannot authorize edits. Remove uses exact saved rule text. Already-applied approvals return the current rules without replaying the edit. Each rule may have up to 500 characters.
