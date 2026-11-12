# Cards: confirm, choose or reply

Every Neo card already has Reply in chat, and a card nobody answers stays open. Yet a yes/no card must carry a no button, so Neo fills it with "not now" wording that only closes the card. This design leaves three shapes, by what the human can do: confirm one action, choose among real actions, or reply in their own words.

## Problem

- `neo.question.ask` requires both labels on a yes/no card (`question-operations.ts`, `AskKinds`: `noLabel: Text`), and its description tells Neo the no side means "keep things as they are" (`neo.question.ask.md`). When a question has one real action, Neo has to invent a second button.
- In practice close to half of all yes/no cards carry a no label meaning "later" ("not now", "hold", "leave it", "let me think"), and only a few percent of answered ones are answered no, several of those "later" too. Clicking such a button closes the card as `no`; Neo is told one line and nothing brings the question back, while leaving the card open would have kept it.
- The rest of the no answers were real second actions ("leave it running", "keep the current scope", "use the other model"), which are a choice between two actions.
- A choice card needs at least two options (`options: z.array(Text).min(2)`), so the same filler shows up there as a "later" option.

## Design

1. **Three shapes.** A card is one of:
   - **Confirm:** one action. Not answering means not decided; anything else goes to Reply in chat.
   - **Choose:** two or more real actions, single or multiple.
   - **Reply:** no buttons, answered in chat.

   Confirm is a `choice` card with one option, so no new kind, column or migration is needed. Choose is a `choice` card with several options. Reply is unchanged.
2. **The tool offers only these.** `neo.question.ask` drops `yesno` from Neo's kinds and lets `choice` take 1 to 6 options. The description says that each option is an action the human can take, that a card left open is undecided so no option may mean later or not now, and that one option is a confirmation. This replaces the yes/no paragraph; it is the same reasoning the description already uses to forbid an "other" option.
3. **Home proposals confirm.** A home proposal (`confirm: {path, sha256}`) becomes a one-option choice. Its save check (`home/confirmation.ts`) accepts a human button answer equal to that option, in place of `kind yesno` with answer `yes`. `root.md` names the new shape.
4. **The daemon's own two-action cards become choices.** Rule changes (Apply or Keep current rules), pack settings (Apply or Keep current settings) and the coding pack's home repository (Create private repo or Keep local) are fixed two-option choices. Their readers (`neo-rule-answer.ts`, `pack-preference-answer.ts`, `packs/coding/home/github.ts`) match the apply option instead of `yes`. After this no new card is a yes/no card.

## Not changed

- **Clients.** The iOS app and the web page already draw a single-choice card of any length as tappable rows, so a one-option card needs no client release.
- **Existing yes/no cards.** Open and answered ones keep working; the `yesno` kind stays readable until the cleanup slice of the todo design.
- **Start cards.** Their "Not now" goes away when they become multi-select choices (todo design, slice 5).
- **The chat side.** Chat answers to a card are recorded as today. Offering a card's options in the main chat, for people who never open cards, is separate work.

## Change

- PR 1: points 1 to 3 (`question-operations.ts`, `neo.question.ask.md`, `root.md`, `home/confirmation.ts`). Tests: a one-option choice opens and is answered by its option; a yes/no from Neo is refused; a home save passes on the confirmed option and fails on any other answer or on another card.
- PR 2: point 4 (`rule-questions.ts`, `preference-questions.ts`, `preference-proposal.ts`, `packs/coding/home/github.ts`, the two answer readers). Tests: each card applies on its apply option and changes nothing on its keep option.
