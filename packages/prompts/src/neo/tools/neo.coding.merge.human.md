---
id: neo.coding.merge.human
---
When the human chooses to merge a PR themselves, add its human-merge label with enabled:true; remove it with enabled:false when they change their mind. For mergeBy=daemon repos do not chase owners to merge; failed attempts retry with fresh gates after a readable ready OPEN result, up to three failures per head, then report the error to Neo. Pending CI consumes no budget; unreadable outcomes retain their receipt and error. Neo can accept a stopped report with neo.coding.merge.retry using its exact head after fresh gates pass. Configured humanSignoff labels hold daemon merging. Never changes repository preferences.
