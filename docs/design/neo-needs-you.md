# Needs you question contract

The human-approved design uses one question for each decision. A question is
projected in `NeoAskView.humanActions` and operation results' `humanActions`:

```ts
{
  kind: 'question',
  itemId: string,
  question: string,
  options: string[],
}
```

`options` is in display order, left to right: decline/negative first,
agree/positive last. For example, `["先不做", "开始调查"]`. The last option is
the primary option. Clients preserve the array order. An empty array means an
open question: show a reply-in-chat cue and no decision button.

Submit an option through `neo.ask.answer` with `askId`, `itemId`, `choice` equal
to the option text, and the current `expectedRevision`. For a chat reply, Neo
records the human's own words through the same operation with the existing
human-message provenance checks. For a grouped start answer in their own words, Neo also passes
`option`, the matching label from that question, while `choice` keeps their
verbatim words and citation. The receipt retains both. Option labels compare
with Unicode, case and whitespace normalization. An answer with no matching
option leaves execution consent pending; it never means decline by default.
When their intent is clear, recording the option starts or cancels only the
question’s exact targets, without another confirmation. Every answer completes the question, including
a negative result. It does not automatically verify a separate outcome item.
There is no follow-up confirmation. A second submission cannot deliver the
answer again; settled, withdrawn and stale questions retain their guards.

`NeoAskView.answer` and the start, approve, answer, confirm, retry, close and talk
human-action variants are removed. Worker failures and refusals remain recorded
facts for Neo. A question exists only when the human has a decision to make.

The first slice changes this question contract and its daemon/web consumers.
The next slice makes proposal approval use these questions, binds each answer
to the exact cards and targets it approves, and removes decision controls from
work cards. Several cards proposed together produce one question. Work cards
then show status and Open session; close/stop remain in the menu.
